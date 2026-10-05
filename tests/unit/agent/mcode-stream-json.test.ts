import { describe, expect, it } from 'vitest';
import {
  McodeStreamTranslator,
  extractToolOutput,
  translateStream,
} from '../../../src/agent/mcode/stream-json';
import type { AgentEvent } from '../../../src/agent/types';

/**
 * Frames below are verbatim shapes captured from `mcode exec
 * --output-format stream-json` 0.6.x, including the repeated `item.updated`
 * frames and the numeric `toolCall.status` values mcode emits.
 */
const SESSION_ID = 'mvs_cb3fa99b8aa7491485d8dc4ee32fd0f9';

const sessionStarted = {
  schemaVersion: 1,
  sequence: 1,
  timestampMs: 1,
  sessionId: SESSION_ID,
  type: 'session.started',
};

function textEvents(events: AgentEvent[]): string[] {
  return events.filter((e): e is Extract<AgentEvent, { type: 'text' }> => e.type === 'text').map((e) => e.delta);
}

describe('McodeStreamTranslator', () => {
  it('emits a single system event carrying the session id, even though both exec.started and session.started exist', () => {
    const translator = new McodeStreamTranslator({ cwd: '/work' });

    const first = translator.translate({ ...sessionStarted, type: 'exec.started' });
    const second = translator.translate(sessionStarted);

    expect(first).toEqual([
      { type: 'system', sessionId: SESSION_ID, cwd: '/work' },
    ]);
    expect(second).toEqual([]);
  });

  it('forwards incremental text deltas as they land', () => {
    // Verified against mcode: a 5-line answer arrives as "LINE " then the rest,
    // and concatenating the deltas reproduces the completed item's content.
    const translator = new McodeStreamTranslator({ cwd: '/work' });

    const started = translator.translate({
      ...sessionStarted,
      type: 'item.started',
      item: { id: 'm1', type: 'agent_message', contentDelta: 'LINE ' },
    });
    const updated = translator.translate({
      ...sessionStarted,
      type: 'item.updated',
      item: { id: 'm1', type: 'agent_message', contentDelta: '1\nLINE 2\nLINE 3' },
    });
    const completed = translator.translate({
      ...sessionStarted,
      type: 'item.completed',
      item: { id: 'm1', type: 'agent_message', content: 'LINE 1\nLINE 2\nLINE 3' },
    });

    expect(textEvents([...started, ...updated, ...completed])).toEqual([
      'LINE ',
      '1\nLINE 2\nLINE 3',
    ]);
  });

  it('emits tool_use exactly once even though mcode repeats the tool_call across updates', () => {
    const translator = new McodeStreamTranslator({ cwd: '/work' });

    const all = [
      translator.translate({
        ...sessionStarted,
        type: 'item.started',
        item: { id: 'c1', type: 'tool_call', toolCall: { id: 'c1', name: 'bash', status: 4 } },
      }),
      translator.translate({
        ...sessionStarted,
        type: 'item.updated',
        item: { id: 'c1', type: 'tool_call', toolCall: { id: 'c1', name: 'bash', status: 5 } },
      }),
      translator.translate({
        ...sessionStarted,
        type: 'item.updated',
        item: {
          id: 'c1',
          type: 'tool_call',
          toolCall: { id: 'c1', name: 'bash', status: 1, input: { command: 'ls' } },
        },
      }),
    ].flat();

    const toolUse = all.filter((e) => e.type === 'tool_use');
    expect(toolUse).toEqual([{ type: 'tool_use', id: 'c1', name: 'bash', input: { command: 'ls' } }]);
  });

  it('emits tool_result once, with isError derived from the execution status', () => {
    const translator = new McodeStreamTranslator({ cwd: '/work' });

    const withOutput = {
      ...sessionStarted,
      type: 'item.updated',
      item: {
        id: 'c1',
        type: 'tool_call',
        toolCall: {
          id: 'c1',
          name: 'bash',
          status: 3,
          input: { command: 'nope' },
          output: {
            content: [{ type: 'text', text: 'command not found' }],
            details: { execution: { status: 'failed', exitCode: 127 } },
          },
        },
      },
    };

    const first = translator.translate(withOutput);
    const repeat = translator.translate(withOutput);

    // This single frame carries both `input` and `output`, so the translator
    // emits tool_use then tool_result together — the card needs the tool_use to
    // exist before its result can be attached.
    expect(first).toEqual([
      { type: 'tool_use', id: 'c1', name: 'bash', input: { command: 'nope' } },
      {
        type: 'tool_result',
        id: 'c1',
        output: 'command not found',
        isError: true,
      },
    ]);
    expect(repeat).toEqual([]);
  });

  it('reports usage once even though turn.completed and exec.completed both carry it', () => {
    const usage = { inputTokens: 1122, outputTokens: 63, cacheReadTokens: 16768, totalTokens: 1185 };
    const translator = new McodeStreamTranslator({ cwd: '/work' });

    const fromTurn = translator.translate({ ...sessionStarted, type: 'turn.completed', usage });
    const fromExec = translator.translate({
      ...sessionStarted,
      type: 'exec.completed',
      result: { status: 'succeeded', output: 'done', usage },
    });

    expect(fromTurn).toEqual([
      {
        type: 'usage',
        inputTokens: 1122,
        outputTokens: 63,
        cachedInputTokens: 16768,
      },
    ]);
    // exec.completed repeats the same usage, so it must not double-count.
    expect(fromExec.map((e) => e.type)).toEqual(['final_text', 'done']);
  });

  it('prefers result.output as the final answer and terminates normally', () => {
    const translator = new McodeStreamTranslator({ cwd: '/work' });

    const events = translator.translate({
      ...sessionStarted,
      type: 'exec.completed',
      result: { status: 'succeeded', output: 'The answer is 42.' },
    });

    expect(events).toEqual([
      { type: 'final_text', content: 'The answer is 42.' },
      { type: 'done', sessionId: SESSION_ID, terminationReason: 'normal' },
    ]);
  });

  it('falls back to the last completed agent_message when result.output is empty', () => {
    const translator = new McodeStreamTranslator({ cwd: '/work' });

    translator.translate({
      ...sessionStarted,
      type: 'item.completed',
      item: { id: 'm1', type: 'agent_message', content: 'from item' },
    });
    const events = translator.translate({
      ...sessionStarted,
      type: 'exec.completed',
      result: { status: 'succeeded', output: '' },
    });

    expect(events).toEqual([
      { type: 'final_text', content: 'from item' },
      { type: 'done', sessionId: SESSION_ID, terminationReason: 'normal' },
    ]);
  });

  it('surfaces a failed run as an error event instead of a done event', () => {
    const translator = new McodeStreamTranslator({ cwd: '/work' });

    const events = translator.translate({
      ...sessionStarted,
      type: 'exec.completed',
      result: { status: 'failed', errorMessage: 'model unavailable' },
    });

    expect(events).toEqual([
      { type: 'error', message: 'mcode run failed: model unavailable', terminationReason: 'failed' },
    ]);
  });

  it('ignores unknown event and item types instead of breaking an in-flight run', () => {
    const translator = new McodeStreamTranslator({ cwd: '/work' });

    expect(translator.translate({ ...sessionStarted, type: 'brand.new.event' })).toEqual([]);
    expect(
      translator.translate({
        ...sessionStarted,
        type: 'item.started',
        item: { id: 'x', type: 'file_change', whatever: true },
      }),
    ).toEqual([]);
    expect(translator.translate(null)).toEqual([]);
    expect(translator.translate('not an object')).toEqual([]);
  });
});

describe('translateStream', () => {
  it('skips blank lines and non-JSON noise on stdout', () => {
    const lines = [
      '',
      'not json at all',
      JSON.stringify({ type: 'exec.started', sessionId: SESSION_ID }),
      '   ',
      JSON.stringify({
        type: 'exec.completed',
        sessionId: SESSION_ID,
        result: { status: 'succeeded', output: 'ok' },
      }),
    ];

    const events = [...translateStream(lines, { cwd: '/work' })];

    expect(events.map((e) => e.type)).toEqual(['system', 'final_text', 'done']);
  });
});

describe('extractToolOutput', () => {
  it('joins text parts and reads failure from details.execution', () => {
    expect(
      extractToolOutput({
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
        details: { execution: { status: 'failed' } },
      }),
    ).toEqual({ output: 'ab', isError: true });
  });

  it('treats a successful execution as non-error even when a numeric status looks unusual', () => {
    // `toolCall.status` is an internal mcode enum and is deliberately not used
    // for error detection; only observable execution status counts.
    expect(
      extractToolOutput({
        content: [{ type: 'text', text: 'ok' }],
        details: { execution: { status: 'succeeded', exitCode: 0 } },
      }),
    ).toEqual({ output: 'ok', isError: false });
  });

  it('handles a plain string payload and junk', () => {
    expect(extractToolOutput('raw')).toEqual({ output: 'raw', isError: false });
    expect(extractToolOutput(undefined)).toEqual({ output: '', isError: false });
  });
});
