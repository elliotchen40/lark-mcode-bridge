import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mcodeCapability } from '../../../src/agent/capability.js';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { ProcessPool } from '../../../src/bot/process-pool.js';
import {
  recordRunSessionEvent,
  startRunFlow,
  type StartRunFlowInput,
} from '../../../src/bot/run-flow.js';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { RunExecutor } from '../../../src/runtime/run-executor.js';
import { SessionCatalog } from '../../../src/session/catalog.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

describe('agent-aware run-flow resume', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('resumes the mcode session only when scope, agent, cwd, and policy fingerprint match', async () => {
    const h = await createHarness();
    const first = await start(h);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('expected initial run');
    await collect(first.execution.subscribe());

    h.catalog.upsertActive({
      scopeId: 'chat-1',
      agentId: 'mcode',
      cwdRealpath: first.cwdRealpath,
      policyFingerprint: first.policy.policyFingerprint,
      sessionId: 'sess-catalog',
      now: 1000,
    });

    const second = await start(h);

    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('expected resumed run');
    expect(second.resumeFrom).toBe('sess-catalog');
    expect(h.agent.runOptions[1]).toMatchObject({
      sessionId: 'sess-catalog',
    });
  });

  it('falls back to legacy SessionStore entries when the agent-aware catalog has no match', async () => {
    const h = await createHarness();
    const cwdRealpath = await realpath(h.tmp.workspace);
    h.sessions.set('chat-1', 'legacy-session', cwdRealpath);

    const run = await start(h);

    expect(run.ok).toBe(true);
    if (!run.ok) throw new Error('expected resumed legacy run');
    expect(run.resumeFrom).toBe('legacy-session');
    expect(h.agent.runOptions[0]).toMatchObject({
      sessionId: 'legacy-session',
    });
  });

  it('does not resume when the policy fingerprint changes', async () => {
    const h = await createHarness();
    const first = await start(h);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('expected initial run');
    await collect(first.execution.subscribe());
    h.catalog.upsertActive({
      scopeId: 'chat-1',
      agentId: 'mcode',
      cwdRealpath: first.cwdRealpath,
      policyFingerprint: 'stale-fingerprint',
      sessionId: 'sess-stale',
      now: 1000,
    });

    const second = await start(h);

    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('expected fresh run');
    expect(second.resumeFrom).toBeUndefined();
    expect(h.agent.runOptions[1]).toMatchObject({
      sessionId: undefined,
    });
  });

  it('records system session identifiers into the agent-aware catalog', async () => {
    const h = await createHarness();
    const run = await start(h);
    expect(run.ok).toBe(true);
    if (!run.ok) throw new Error('expected mcode run');
    await collect(run.execution.subscribe());

    recordRunSessionEvent({
      scopeId: 'chat-1',
      sessions: h.sessions,
      sessionCatalog: h.catalog,
      capability: mcodeCapability(h.profileConfig),
      policy: run.policy,
      event: { type: 'system', sessionId: 'sess-recorded', cwd: run.cwdRealpath },
    });

    expect(
      h.catalog.activeFor({
        scopeId: 'chat-1',
        agentId: 'mcode',
        cwdRealpath: run.cwdRealpath,
        policyFingerprint: run.policy.policyFingerprint,
      }),
    ).toMatchObject({ sessionId: 'sess-recorded' });
    expect(h.sessions.resumeFor('chat-1', run.cwdRealpath)).toBe('sess-recorded');
  });
});

async function createHarness(): Promise<{
  tmp: TmpProfile;
  agent: FakeAgentAdapter;
  executor: RunExecutor;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  catalog: SessionCatalog;
  profileConfig: ProfileConfig;
}> {
  const tmp = await createTmpProfile('resume-mcode-test-');
  const agent = new FakeAgentAdapter({
    id: 'mcode',
    displayName: 'MiniMax Code',
    events: [[{ type: 'done', terminationReason: 'normal' }]],
  });
  const profileConfig = createDefaultProfileConfig({
    agentKind: 'mcode',
    accounts: {
      app: {
        id: 'cli_test',
        secret: '${APP_SECRET}',
        tenant: 'feishu',
      },
    },
    mcode: { binaryPath: '/usr/bin/mcode' },
  });
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  workspaces.setCwd('chat-1', tmp.workspace);
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const catalog = new SessionCatalog(join(tmp.profile, 'session-catalog.json'));
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush(), catalog.flush()]);
    await tmp.cleanup();
  });
  return {
    tmp,
    agent,
    executor: new RunExecutor({
      agent,
      pool: new ProcessPool(() => 10),
      activeRuns: new ActiveRuns(),
      createRunId: () => `run-${agent.runOptions.length + 1}`,
      now: () => 1000,
    }),
    sessions,
    workspaces,
    catalog,
    profileConfig: {
      ...profileConfig,
      workspaces: {
        ...profileConfig.workspaces,
        default: tmp.workspace,
      },
    },
  };
}

async function collect(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of events) {
    /* drain */
  }
}

async function start(h: Awaited<ReturnType<typeof createHarness>>) {
  const input = {
    scopeId: 'chat-1',
    scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
    prompt: 'hello',
    attachments: [],
    access: { ok: true, reason: 'allowed-user' },
    capability: mcodeCapability(h.profileConfig),
    profileConfig: h.profileConfig,
    sessions: h.sessions,
    sessionCatalog: h.catalog,
    workspaces: h.workspaces,
    executor: h.executor,
    now: 1000,
  } satisfies StartRunFlowInput & { sessionCatalog: SessionCatalog };
  return startRunFlow(input);
}
