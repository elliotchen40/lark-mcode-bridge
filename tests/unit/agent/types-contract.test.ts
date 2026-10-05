import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(process.cwd(), 'src/agent/types.ts'), 'utf8');

describe('agent type contract', () => {
  it('carries the session identity on the system and done events, plus optional usage cost', () => {
    expect(source).toMatch(/type:\s*'system'[^|]*sessionId\?:\s*string/s);
    expect(source).toMatch(/type:\s*'done'[^|]*sessionId\?:\s*string/s);
    expect(source).toMatch(/type:\s*'usage'[^|]*costUsd\?:\s*number/s);
  });

  it('requires termination reasons on terminal events', () => {
    expect(source).toMatch(/type:\s*'done'[^|]*terminationReason:\s*'normal'\s*\|\s*'interrupted'\s*\|\s*'timeout'/s);
    expect(source).toMatch(/type:\s*'error'[^|]*terminationReason:\s*'failed'\s*\|\s*'interrupted'\s*\|\s*'timeout'/s);
  });

  it('requires runId on run options and run handles', () => {
    expect(source).toMatch(/interface AgentRunOptions[^}]*runId:\s*string/s);
    expect(source).toMatch(/interface AgentRun[^}]*readonly runId:\s*string/s);
    expect(source).toMatch(/interface AgentRunOptions[^}]*sessionId\?:\s*string/s);
  });

  it('takes an mcode permission policy on run options and no Codex-era fields', () => {
    // Slice the interface body first: its doc comments contain `{@link ...}`,
    // whose braces would otherwise terminate a `[^}]*` match early.
    const body = source.slice(source.indexOf('export interface AgentRunOptions'));
    const runOptions = body.slice(0, body.indexOf('\n}'));
    expect(runOptions).toMatch(/permission\?:\s*McodePermissionPolicy/);
    expect(runOptions).toMatch(/sessionId\?:\s*string/);
    // `sandbox` and `threadId` were Codex-only and must not creep back.
    expect(runOptions).not.toMatch(/sandbox\?/);
    expect(runOptions).not.toMatch(/threadId\?/);
    expect(source).not.toMatch(/permissionMode\?/);
  });

  it('exposes no threadId on the mcode event stream', () => {
    expect(source).not.toMatch(/type:\s*'system'[^|]*threadId/s);
    expect(source).not.toMatch(/type:\s*'done'[^|]*threadId/s);
  });
});
