import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McodeAdapter } from '../../src/agent/mcode/adapter';
import type { AgentEvent } from '../../src/agent/types';

const SESSION_ID = 'mvs_process_test_session';

/**
 * Stand-in for the `mcode` binary.
 *
 * It records the argv and stdin it received (so the test can assert how the
 * adapter really invokes mcode), then replays a realistic NDJSON stream: one
 * streaming delta, one tool call that fails, and a successful completion.
 */
const FAKE_MCODE = `#!/usr/bin/env node
const fs = require('node:fs');
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const prompt = Buffer.concat(chunks).toString('utf8');
  fs.writeFileSync(process.env.MCODE_PROBE_ARGV, JSON.stringify(process.argv.slice(2)));
  fs.writeFileSync(process.env.MCODE_PROBE_STDIN, prompt);
  const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  const base = { schemaVersion: 1, sessionId: process.env.MCODE_PROBE_SESSION, turnId: 't1' };
  line({ ...base, sequence: 1, type: 'session.started' });
  line({ ...base, sequence: 2, type: 'turn.started' });
  line({ ...base, sequence: 3, type: 'item.started', item: { id: 'm1', type: 'agent_message', contentDelta: 'Checking ' } });
  line({ ...base, sequence: 4, type: 'item.updated', item: { id: 'm1', type: 'agent_message', contentDelta: 'files…' } });
  line({ ...base, sequence: 5, type: 'item.started', item: { id: 'c1', type: 'tool_call', toolCall: { id: 'c1', name: 'bash', status: 4 } } });
  line({ ...base, sequence: 6, type: 'item.updated', item: { id: 'c1', type: 'tool_call', toolCall: { id: 'c1', name: 'bash', status: 3, input: { command: 'nope' }, output: { content: [{ type: 'text', text: 'not found' }], details: { execution: { status: 'failed' } } } } } });
  line({ ...base, sequence: 7, type: 'item.completed', item: { id: 'm1', type: 'agent_message', content: 'Checking files…' } });
  line({ ...base, sequence: 8, type: 'turn.completed', model: { modelId: 'MiniMax-M3.1-Flash-Preview' }, usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, totalTokens: 14 } });
  line({ ...base, sequence: 9, type: 'exec.completed', result: { status: 'succeeded', output: 'All done.', usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, totalTokens: 14 } } });
});
`;

describe('McodeAdapter (process)', () => {
  let dir: string;
  let binary: string;
  let argvFile: string;
  let stdinFile: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcode-adapter-'));
    binary = join(dir, 'fake-mcode.js');
    argvFile = join(dir, 'argv.json');
    stdinFile = join(dir, 'stdin.txt');
    await writeFile(binary, FAKE_MCODE);
    await chmod(binary, 0o755);
    process.env.MCODE_PROBE_ARGV = argvFile;
    process.env.MCODE_PROBE_STDIN = stdinFile;
    process.env.MCODE_PROBE_SESSION = SESSION_ID;
  });

  afterEach(async () => {
    delete process.env.MCODE_PROBE_ARGV;
    delete process.env.MCODE_PROBE_STDIN;
    delete process.env.MCODE_PROBE_SESSION;
  });

  async function runAdapter(prompt: string): Promise<AgentEvent[]> {
    // The fake binary carries a `#!/usr/bin/env node` shebang and is chmod +x,
    // so it can be spawned directly exactly like the real `mcode` command.
    const adapter = new McodeAdapter({ binary });
    const run = adapter.run({ runId: 'r1', prompt, cwd: dir, permission: 'full' });
    const events: AgentEvent[] = [];
    for await (const evt of run.events) events.push(evt);
    return events;
  }

  it('translates a real mcode NDJSON stream into bridge events', async () => {
    const events = await runAdapter('hello');

    const types = events.map((e) => e.type);
    expect(types).toContain('system');
    expect(types).toContain('tool_use');
    expect(types).toContain('tool_result');
    expect(types).toContain('final_text');
    expect(types.at(-1)).toBe('done');
  });

  it('reports the session id from the system event and the final answer from exec.completed', async () => {
    const events = await runAdapter('hello');

    expect(events.find((e) => e.type === 'system')).toMatchObject({
      sessionId: SESSION_ID,
      cwd: dir,
    });
    expect(events.find((e) => e.type === 'final_text')).toEqual({
      type: 'final_text',
      content: 'All done.',
    });
  });

  it('streams both text deltas once and marks the failed tool call as an error', async () => {
    const events = await runAdapter('hello');

    const deltas = events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta);
    expect(deltas).toEqual(['Checking ', 'files…']);
    expect(events.find((e) => e.type === 'tool_result')).toEqual({
      type: 'tool_result',
      id: 'c1',
      output: 'not found',
      isError: true,
    });
  });

  it('delivers the prompt on stdin, never in argv', async () => {
    await runAdapter('my secret <prompt>');

    const argv = JSON.parse(await readFile(argvFile, 'utf8')) as string[];
    const stdin = await readFile(stdinFile, 'utf8');

    expect(argv).toContain('--input');
    expect(argv.join(' ')).not.toContain('secret');
    expect(stdin).toContain('my secret <prompt>');
  });

  it('prepends the bridge system prompt so the agent knows it is operating from Feishu', async () => {
    await runAdapter('do the thing');

    const stdin = await readFile(stdinFile, 'utf8');
    // prefixBridgeSystemPrompt wraps the user turn; both parts must be present.
    expect(stdin).toContain('do the thing');
    expect(stdin.length).toBeGreaterThan('do the thing'.length);
  });

  it('surfaces a non-zero exit as an error event instead of a done event', async () => {
    const failing = join(dir, 'failing-mcode.js');
    await writeFile(
      failing,
      `#!/usr/bin/env node\nlet d=[];process.stdin.on('data',c=>d.push(c));process.stdin.on('end',()=>{console.error('boom');process.exit(3)});\n`,
    );
    await chmod(failing, 0o755);

    const adapter = new McodeAdapter({ binary: failing });
    const run = adapter.run({ runId: 'r1', prompt: 'x', cwd: dir, permission: 'full' });
    const events: AgentEvent[] = [];
    for await (const evt of run.events) events.push(evt);

    const error = events.find((e) => e.type === 'error');
    expect(error).toBeDefined();
    expect((error as { message: string }).message).toMatch(/exited with code 3/);
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });

  it('reports a spawn failure when the binary does not exist', async () => {
    const adapter = new McodeAdapter({ binary: join(dir, 'does-not-exist') });
    const run = adapter.run({ runId: 'r1', prompt: 'x', cwd: dir, permission: 'full' });
    const events: AgentEvent[] = [];
    for await (const evt of run.events) events.push(evt);

    expect(events[0]?.type).toBe('error');
  });
});
