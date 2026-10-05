import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { log } from '../../core/logger';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { prefixBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import {
  MCODE_DEFAULT_PERMISSION_POLICY,
  type AgentAdapter,
  type AgentBotIdentity,
  type AgentEvent,
  type AgentRun,
  type AgentRunOptions,
} from '../types';
import { buildMcodeArgs } from './argv';
import { McodeStreamTranslator } from './stream-json';

export interface McodeAdapterOptions {
  /** Path to the `mcode` binary. Resolved from PATH when omitted. */
  binary?: string;
  larkChannel?: LarkChannelEnvContext;
}

type McodeChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

/**
 * Adapter for the `mcode` CLI (package `@minimax-ai/code`).
 *
 * Each user message becomes one `mcode exec --output-format stream-json`
 * process; the run's continuity comes from resuming the session id reported by
 * the previous run (`--session`), not from a long-lived process. That mirrors
 * how the bridge already drove `claude -p`, so restarts and `/new` behave the
 * same way.
 */
export class McodeAdapter implements AgentAdapter {
  readonly id = 'mcode';
  readonly displayName = 'MiniMax Code';

  private readonly binary: string;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: McodeAdapterOptions = {}) {
    this.binary = opts.binary ?? 'mcode';
    this.larkChannel = opts.larkChannel;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'mcode',
      agentName: this.displayName,
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for McodeAdapter.run');
    }

    const args = buildMcodeArgs({
      cwd: opts.cwd,
      permission: opts.permission ?? MCODE_DEFAULT_PERMISSION_POLICY,
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.images?.length ? { files: opts.images } : {}),
    });

    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, buildLarkChannelEnv(this.larkChannel)),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as McodeChild;

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd,
      permission: opts.permission ?? MCODE_DEFAULT_PERMISSION_POLICY,
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      model: opts.model,
    });

    // Listeners MUST be attached synchronously here, before returning: a spawn
    // failure emits 'error' on the next tick and would otherwise fire into the
    // void, hanging the event stream.
    const stderrChunks: Buffer[] = [];
    let runtimeError: Error | null = null;
    let stderrBuffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBuffer += chunk.toString('utf8');
      let nl = stderrBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = stderrBuffer.slice(0, nl);
        stderrBuffer = stderrBuffer.slice(nl + 1);
        if (line.trim()) log.warn('agent', 'stderr', { line });
        if (isWindowsCommandNotFoundLine(line)) {
          runtimeError = new Error(`failed to spawn mcode: ${line.trim()}`);
          child.stdout.destroy();
          child.kill();
        }
        nl = stderrBuffer.indexOf('\n');
      }
    });

    child.on('error', (err) => {
      runtimeError = err;
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
    });
    child.stdin.on('error', (err) => {
      log.warn('agent', 'stdin-error', { message: err.message });
    });

    // mcode has no `--append-system-prompt-file`, so the bridge contract is
    // prepended to the user turn instead (the same approach the retired Codex
    // adapter used). Kept on stdin so no shell ever sees the XML-ish tags.
    child.stdin.end(prefixBridgeSystemPrompt(opts.prompt, this.botIdentity), 'utf8');

    // mcode may have live subprocesses of its own (lark-cli waiting on OAuth,
    // a long shell command), so the grace period before SIGKILL must be
    // generous enough for them to flush state.
    const stopGraceMs = opts.stopGraceMs ?? 5000;

    return {
      runId: opts.runId,
      events: createEventStream(child, opts.cwd, stderrChunks, () => runtimeError),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        log.info('agent', 'stop-sigterm', { pid: child.pid ?? null, graceMs: stopGraceMs });
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              log.warn('agent', 'stop-sigkill', {
                pid: child.pid ?? null,
                graceMs: stopGraceMs,
                reason: 'grace-period-expired',
              });
              child.kill('SIGKILL');
            }
            resolve();
          }, stopGraceMs);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        if (child.exitCode !== null || child.signalCode !== null) {
          return Promise.resolve(true);
        }
        return new Promise<boolean>((resolve) => {
          const onExit = (): void => {
            clearTimeout(timer);
            resolve(true);
          };
          const timer = setTimeout(() => {
            child.removeListener('exit', onExit);
            resolve(false);
          }, timeoutMs);
          child.once('exit', onExit);
        });
      },
    };
  }
}

async function* createEventStream(
  child: McodeChild,
  cwd: string,
  stderrChunks: Buffer[],
  getError: () => Error | null,
): AsyncGenerator<AgentEvent> {
  // A synchronous spawn failure leaves child.pid undefined; the 'error' event
  // (ENOENT etc.) fires on the next tick, so also consult getError().
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn mcode: ${err.message}` : 'spawn returned no pid',
      terminationReason: 'failed',
    };
    return;
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let sawStdout = false;
  let silentExitTimer: ReturnType<typeof setTimeout> | undefined;
  const closeSilentStdout = (): void => {
    silentExitTimer = setTimeout(() => {
      if (!sawStdout && !child.stdout.readableEnded) child.stdout.destroy();
    }, 50);
  };
  child.once('exit', closeSilentStdout);

  const translator = new McodeStreamTranslator({ cwd });
  try {
    for await (const line of rl) {
      sawStdout = true;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      yield* translator.translate(parsed);
    }
  } finally {
    if (silentExitTimer) clearTimeout(silentExitTimer);
    child.removeListener('exit', closeSilentStdout);
    rl.close();
  }

  const earlyRuntimeError = getError();
  if (earlyRuntimeError && child.exitCode === null && child.signalCode === null) {
    yield {
      type: 'error',
      message: `mcode runtime error: ${earlyRuntimeError.message}`,
      terminationReason: 'failed',
    };
    return;
  }

  // When killed by a signal exitCode stays null and signalCode carries the
  // name; both must be checked or we would wait on an event that already fired.
  const exitCode = await new Promise<number | null>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode);
    } else {
      child.once('exit', (code) => resolve(code));
    }
  });

  const runtimeError = getError();
  if (exitCode !== 0 && exitCode !== null) {
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
    const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
    yield {
      type: 'error',
      message: `mcode exited with code ${exitCode}${detail}`,
      terminationReason: 'failed',
    };
  } else if (runtimeError) {
    yield {
      type: 'error',
      message: `mcode runtime error: ${runtimeError.message}`,
      terminationReason: 'failed',
    };
  }
}

function isWindowsCommandNotFoundLine(line: string): boolean {
  return (
    process.platform === 'win32' &&
    /is not recognized as an internal or external command|operable program or batch file/i.test(line)
  );
}
