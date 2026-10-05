import type { AgentEvent } from '../types';

/**
 * mcode's `exec --output-format stream-json` protocol.
 *
 * Every line of stdout is one NDJSON object shaped like:
 *
 * ```jsonc
 * { "schemaVersion": 1, "sequence": 7, "sessionId": "mvs_...", "type": "turn.completed",
 *   "model": { "providerId": "minimax", "modelId": "MiniMax-M3.1-Flash-Preview" },
 *   "usage": { "inputTokens": 1, "outputTokens": 2, "cacheReadTokens": 3, "totalTokens": 4 } }
 * ```
 *
 * The lifecycle is `exec.started` -> `session.started` -> `turn.started` ->
 * (`item.started` | `item.updated` | `item.completed`)* -> `turn.completed` ->
 * `exec.completed`. Assistant output arrives as `item`s of type
 * `agent_message`, tool activity as `tool_call`.
 *
 * Two properties of the protocol drive the design of this translator and were
 * verified against `mcode` 0.6.x rather than assumed:
 *
 *  1. `contentDelta` is INCREMENTAL, not cumulative. A 5-line answer arrives as
 *     `"LINE "` then `"1\nLINE 2\nLINE 3\nLINE 4\nLINE 5"` — concatenating the
 *     deltas reproduces `item.completed`'s `content` exactly. So deltas can be
 *     forwarded to the card as they land.
 *  2. `item.updated` repeats the whole item each time and a single tool call
 *     can be updated several times (pending -> running -> has input -> has
 *     output). Without de-duplication a card would render the same tool call
 *     several times, so `tool_use` / `tool_result` are emitted exactly once
 *     per tool call id.
 *
 * Unknown `type` and `item.type` values are ignored rather than throwing: mcode
 * adds item kinds over time (thinking, file changes, sub-agent activity) and
 * an unrecognised kind must not break an in-flight run.
 */
export interface McodeItem {
  id?: string;
  type?: string;
  contentDelta?: string;
  content?: string;
  thinkingDelta?: string;
  toolCall?: McodeToolCall;
}

interface McodeToolCall {
  id?: string;
  name?: string;
  /** Numeric lifecycle marker owned by mcode. Intentionally not interpreted —
   *  see {@link extractToolOutput} — because its mapping is internal. */
  status?: number;
  input?: unknown;
  output?: unknown;
}

interface McodeUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  totalTokens?: number;
}

interface McodeRawEvent {
  type?: string;
  sessionId?: string;
  cwd?: string;
  model?: { modelId?: string; providerId?: string };
  item?: McodeItem;
  usage?: McodeUsage;
  result?: {
    status?: string;
    output?: string;
    usage?: McodeUsage;
    errorMessage?: string;
  };
}

export interface McodeStreamTranslatorOptions {
  /** Workspace the run was pinned to; surfaced on the `system` event. */
  cwd?: string;
}

/**
 * Stateful NDJSON -> {@link AgentEvent} translator.
 *
 * One instance per run: it owns the de-duplication sets that make repeated
 * `item.updated` frames safe to feed in.
 */
export class McodeStreamTranslator {
  private readonly cwd: string | undefined;
  /** tool call id -> phases already emitted, so nothing is rendered twice. */
  private readonly emittedToolUse = new Set<string>();
  private readonly emittedToolResult = new Set<string>();
  /** Usage is reported by both `turn.completed` and `exec.completed`. */
  private readonly emittedUsage = new Set<string>();
  private systemEmitted = false;
  private finalAnswer = '';

  constructor(opts: McodeStreamTranslatorOptions = {}) {
    this.cwd = opts.cwd;
  }

  /** Translate one NDJSON line. Returns `[]` for lines carrying no event. */
  translate(raw: unknown): AgentEvent[] {
    if (!raw || typeof raw !== 'object') return [];
    const evt = raw as McodeRawEvent;
    const events: AgentEvent[] = [];

    switch (evt.type) {
      case 'exec.started':
      case 'session.started': {
        // Both frames exist; only the first one is interesting.
        if (this.systemEmitted) return [];
        this.systemEmitted = true;
        events.push({
          type: 'system',
          ...(evt.sessionId ? { sessionId: evt.sessionId } : {}),
          ...(evt.cwd ?? this.cwd ? { cwd: evt.cwd ?? this.cwd } : {}),
          ...(evt.model?.modelId ? { model: evt.model.modelId } : {}),
        });
        return events;
      }

      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        return this.translateItem(evt);

      case 'turn.completed':
        return this.usageEvents(evt.usage);

      case 'exec.completed':
        return this.translateExecCompleted(evt);

      default:
        return [];
    }
  }

  private translateItem(evt: McodeRawEvent): AgentEvent[] {
    const item = evt.item;
    if (!item) return [];

    switch (item.type) {
      case 'agent_message': {
        const events: AgentEvent[] = [];
        // Incremental streaming delta (see protocol notes above).
        if (typeof item.contentDelta === 'string' && item.contentDelta) {
          events.push({ type: 'text', delta: item.contentDelta });
        }
        if (evt.type === 'item.completed' && typeof item.content === 'string' && item.content) {
          this.finalAnswer = item.content;
        }
        return events;
      }

      case 'thinking':
      case 'reasoning': {
        const delta = item.thinkingDelta ?? item.contentDelta;
        return typeof delta === 'string' && delta ? [{ type: 'thinking', delta }] : [];
      }

      case 'tool_call':
        return this.translateToolCall(item);

      default:
        return [];
    }
  }

  private translateToolCall(item: McodeItem): AgentEvent[] {
    const call = item.toolCall;
    const id = call?.id ?? item.id;
    if (!call?.name || !id) return [];
    const events: AgentEvent[] = [];

    // Emit `tool_use` the first time the input is known — that is the point
    // the card can render "running <name>".
    if (call.input !== undefined && !this.emittedToolUse.has(id)) {
      this.emittedToolUse.add(id);
      events.push({ type: 'tool_use', id, name: call.name, input: call.input });
    }

    if (call.output !== undefined && !this.emittedToolResult.has(id)) {
      this.emittedToolResult.add(id);
      const { output, isError } = extractToolOutput(call.output);
      events.push({ type: 'tool_result', id, output, isError });
    }

    return events;
  }

  private usageEvents(usage: McodeUsage | undefined): AgentEvent[] {
    if (!usage) return [];
    // Identical usage arrives on both turn.completed and exec.completed.
    const signature = [
      usage.inputTokens,
      usage.outputTokens,
      usage.cacheReadTokens,
      usage.totalTokens,
    ].join('/');
    if (this.emittedUsage.has(signature)) return [];
    this.emittedUsage.add(signature);
    return [
      {
        type: 'usage',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cacheReadTokens,
      },
    ];
  }

  private translateExecCompleted(evt: McodeRawEvent): AgentEvent[] {
    const result = evt.result;
    if (!result) return [];

    const events = this.usageEvents(result.usage);

    if (result.status && result.status !== 'succeeded') {
      events.push({
        type: 'error',
        message: `mcode run ${result.status}${result.errorMessage ? `: ${result.errorMessage}` : ''}`,
        terminationReason: 'failed',
      });
      return events;
    }

    // `result.output` is the authoritative final answer; prefer it over the
    // last completed agent_message, which may be an intermediate step.
    const output = typeof result.output === 'string' && result.output ? result.output : this.finalAnswer;
    if (output) events.push({ type: 'final_text', content: output });

    events.push({
      type: 'done',
      ...(evt.sessionId ? { sessionId: evt.sessionId } : {}),
      terminationReason: 'normal',
    });
    return events;
  }
}

/**
 * Flatten a tool result payload to plain text and decide whether it failed.
 *
 * `toolCall.status` is a numeric enum owned by mcode whose meaning is internal
 * (it changes as the UI evolves), so error detection deliberately keys off the
 * observable `details.execution.status` instead.
 */
export function extractToolOutput(output: unknown): { output: string; isError: boolean } {
  if (typeof output === 'string') return { output, isError: false };
  if (!output || typeof output !== 'object') return { output: '', isError: false };

  const raw = output as {
    content?: unknown;
    details?: { execution?: { status?: string }; error?: unknown };
    error?: unknown;
  };

  const parts: string[] = [];
  if (Array.isArray(raw.content)) {
    for (const part of raw.content) {
      if (!part || typeof part !== 'object') continue;
      const text = (part as { text?: unknown }).text;
      if (typeof text === 'string' && text) parts.push(text);
    }
  }

  const isError =
    raw.details?.execution?.status === 'failed' ||
    raw.details?.execution?.status === 'error' ||
    raw.details?.error !== undefined ||
    raw.error !== undefined;

  return { output: parts.join(''), isError };
}

/** Convenience wrapper for callers that translate a whole NDJSON stream. */
export function* translateStream(
  lines: Iterable<string>,
  opts: McodeStreamTranslatorOptions = {},
): Generator<AgentEvent> {
  const translator = new McodeStreamTranslator(opts);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Non-JSON noise on stdout is ignored rather than failing the run.
      continue;
    }
    yield* translator.translate(parsed);
  }
}
