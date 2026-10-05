import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CardActionEvent, NormalizedMessage } from '@larksuite/channel';
import { mcodeCapability } from '../../../src/agent/capability.js';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import type { ChatModeCache } from '../../../src/bot/chat-mode-cache.js';
import { PendingQueue } from '../../../src/bot/pending-queue.js';
import { handleCardAction } from '../../../src/card/dispatcher.js';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { canUseDm } from '../../../src/policy/access.js';
import { evaluateRunPolicy } from '../../../src/policy/run-policy.js';
import { resolveWorkingDirectory } from '../../../src/policy/workspace.js';
import { SessionCatalog, type SessionCatalogIdentity } from '../../../src/session/catalog.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import type { McodeSessionSummary } from '../../../src/agent/mcode/session-history.js';
import { createFakeAgent } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

interface Harness {
  tmp: TmpProfile;
  channel: FakeChannel;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  catalog: SessionCatalog;
  controls: Controls;
  identity: SessionCatalogIdentity;
  /** Stand-in for mcode's own sqlite session store. */
  history: McodeSessionSummary[];
  activeRuns: ActiveRuns;
  pending: PendingQueue;
  run(content: string, options?: { withCatalogIdentity?: boolean; chatMode?: 'p2p' | 'group' | 'topic' }): Promise<boolean>;
  dispatchResumeArg(arg: string): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

describe('mcode resume commands', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('archives only the current catalog entry when starting a new conversation', async () => {
    const h = await createHarness();
    h.catalog.upsertActive({ ...h.identity, sessionId: 'mvs-current', now: 1000 });
    h.catalog.upsertActive({
      ...h.identity,
      cwdRealpath: join(h.tmp.root, 'other-workspace'),
      sessionId: 'mvs-other-cwd',
      now: 1000,
    });

    await expect(h.run('/new')).resolves.toBe(true);

    expect(h.catalog.activeFor(h.identity)).toBeUndefined();
    const other = { ...h.identity, cwdRealpath: join(h.tmp.root, 'other-workspace') };
    expect(h.catalog.activeFor(other)).toMatchObject({ sessionId: 'mvs-other-cwd' });
  });

  it('allows resume use only for the current agent/cwd/policy catalog entry', async () => {
    const h = await createHarness();
    h.catalog.upsertActive({ ...h.identity, sessionId: 'mvs-current', now: 1000 });
    h.catalog.upsertActive({
      ...h.identity,
      policyFingerprint: 'stale-fp',
      sessionId: 'mvs-stale',
      now: 1000,
    });

    await expect(h.run('/resume use mvs-stale')).resolves.toBe(true);
    expect(h.sessions.getRaw('chat-1')).toBeUndefined();
    expect(lastMarkdown(h.channel)).toContain('不可恢复');

    await expect(h.run('/resume use mvs-current')).resolves.toBe(true);
    expect(h.sessions.resumeFor('chat-1', h.identity.cwdRealpath)).toBe('mvs-current');
    expect(lastMarkdown(h.channel)).toContain('已完成');
  });

  it('resumes the selected mcode session from the card button callback', async () => {
    const h = await createHarness();
    h.sessions.set('chat-1', 'mvs-current', h.identity.cwdRealpath);
    h.catalog.upsertActive({ ...h.identity, sessionId: 'mvs-current', now: 1000 });
    h.history.push(
      mcodeSession('mvs-current', 'current prompt', 1_700_000_100_000),
      mcodeSession('mvs-target', 'target prompt', 1_700_000_000_000),
    );

    await expect(h.run('/resume')).resolves.toBe(true);

    const card = lastContent(h.channel);
    const rendered = JSON.stringify(card);
    expect(rendered).toContain('current prompt');
    expect(rendered).toContain('target prompt');
    expect(rendered).toContain('mvs-targ');

    const nonces = resumeArgsFromCard(card);
    // Both sessions are listed, but only the non-current one is offered as a
    // button — clicking "already current" would be a no-op.
    expect(nonces).toHaveLength(1);
    expect(nonces[0]).not.toBe('mvs-target');
    await h.dispatchResumeArg(nonces[0]!);

    expect(h.sessions.resumeFor('chat-1', h.identity.cwdRealpath)).toBe('mvs-target');
    expect(h.catalog.activeFor(h.identity)).toMatchObject({
      sessionId: 'mvs-target',
    });
    expect(lastMarkdown(h.channel)).toContain('已完成');
  });

  it('falls back to an audit-safe reply when resume confirmation is rejected', async () => {
    const h = await createHarness();
    h.history.push(mcodeSession('mvs-current', 'current prompt', 1_700_000_100_000));
    await expect(h.run('/resume')).resolves.toBe(true);
    const [nonce] = resumeArgsFromCard(lastContent(h.channel));
    const originalSend = h.channel.send.bind(h.channel);
    let attempts = 0;
    h.channel.send = async (...args) => {
      attempts += 1;
      if (attempts === 1) {
        const err = new Error('The messages do NOT pass the audit.') as Error & { code: number };
        err.code = 230028;
        throw err;
      }
      return originalSend(...args);
    };

    await expect(h.run(`/resume use ${nonce}`)).resolves.toBe(true);

    expect(attempts).toBe(2);
    expect(lastMarkdown(h.channel)).toBe('命令已处理。');
  });

  it('does not accept a raw mcode session id as a resume candidate', async () => {
    const h = await createHarness();
    h.catalog.upsertActive({ ...h.identity, sessionId: 'mvs-current', now: 1000 });
    h.history.push(mcodeSession('mvs-alpha', 'alpha prompt', 1_700_000_100_000));

    await expect(h.run('/resume')).resolves.toBe(true);
    await expect(h.run('/resume use mvs-alpha')).resolves.toBe(true);

    expect(h.sessions.getRaw('chat-1')).toBeUndefined();
    expect(lastMarkdown(h.channel)).toContain('不可恢复');
  });

  it('previews what the user asked instead of mcode\'s system-prompt-only title', async () => {
    // mcode titles a session from its first user message, which for this bridge
    // is the system prompt plus the request, truncated to ~50 chars — so its
    // title is all system prompt. The bridge's own summary must win.
    const h = await createHarness();
    // Current session is a different one, so this one is listed as selectable
    // and its preview is actually rendered.
    h.sessions.set('chat-1', 'mvs-current', h.identity.cwdRealpath);
    h.catalog.upsertActive({ ...h.identity, sessionId: 'mvs-current' });
    // A different scope, so this does not overwrite the current entry above.
    h.catalog.upsertActive({
      ...h.identity,
      scopeId: 'chat-2',
      sessionId: 'mvs-titled',
      lastSummary: '帮我把 README 标题改一下',
    });
    h.history.push(
      mcodeSession(
        'mvs-titled',
        '# lark-mcode-bridge 运行约定 你正在 lark-mcode-bridge 里跑：',
        1_700_000_100_000,
      ),
    );

    await expect(h.run('/resume')).resolves.toBe(true);

    const rendered = JSON.stringify(lastContent(h.channel));
    expect(rendered).toContain('帮我把 README 标题改一下');
    expect(rendered).not.toContain('运行约定');
  });

  it('falls back to the mcode title when the bridge recorded no summary', async () => {
    const h = await createHarness();
    h.history.push(mcodeSession('mvs-foreign', 'outside the bridge', 1_700_000_100_000));

    await expect(h.run('/resume')).resolves.toBe(true);

    expect(JSON.stringify(lastContent(h.channel))).toContain('outside the bridge');
  });

  it('says so plainly when every listed session is already the current one', async () => {
    // A card whose only session is current has no usable button, which reads as
    // "nothing to choose" unless the card explains it.
    const h = await createHarness();
    h.sessions.set('chat-1', 'mvs-only', h.identity.cwdRealpath);
    h.history.push(mcodeSession('mvs-only', 'only session', 1_700_000_100_000));

    await expect(h.run('/resume')).resolves.toBe(true);

    const rendered = JSON.stringify(lastContent(h.channel));
    expect(rendered).toContain('已是当前会话');
    expect(resumeArgsFromCard(lastContent(h.channel))).toHaveLength(0);
  });

  it('says the cwd is the profile default when no /cd was ever issued', async () => {
    // A silently-chosen working directory looks exactly like an /cd that did
    // not take effect, so the card must not hide that it is the default.
    const h = await createHarness();
    // The harness pre-sets a cwd (as if /cd had been used); drop it so this
    // exercise really covers "no /cd yet".
    h.workspaces.removeCwd('chat-1');
    h.history.push(mcodeSession('mvs-here', 'in the default dir', 1_700_000_100_000));

    await expect(h.run('/resume')).resolves.toBe(true);

    const rendered = JSON.stringify(lastContent(h.channel));
    expect(rendered).toContain('默认工作目录');
    expect(rendered).toContain('/cd');
  });

  it('does not claim the cwd is a default once /cd has chosen one', async () => {
    const h = await createHarness();
    h.workspaces.setCwd('chat-1', h.identity.cwdRealpath);
    h.history.push(mcodeSession('mvs-here', 'in my project', 1_700_000_100_000));

    await expect(h.run('/resume')).resolves.toBe(true);

    const rendered = JSON.stringify(lastContent(h.channel));
    expect(rendered).toContain('in my project');
    expect(rendered).not.toContain('默认工作目录');
  });

  it('renders an empty history card when the session store has nothing for the cwd', async () => {
    const h = await createHarness();

    await expect(h.run('/resume')).resolves.toBe(true);

    expect(lastContentString(h.channel)).toContain('此 cwd 下没有历史会话');
  });

  it('lists mcode history for the current cwd and resumes the selected session through a nonce', async () => {
    const h = await createHarness();
    h.history.push(
      mcodeSession('mvs-alpha-secret', 'alpha prompt', 1_700_000_100_000),
      mcodeSession('mvs-beta-secret', 'beta prompt', 1_700_000_000_000),
    );

    await expect(h.run('/resume')).resolves.toBe(true);

    const card = lastContent(h.channel);
    const rendered = JSON.stringify(card);
    expect(rendered).toContain('alpha prompt');
    expect(rendered).toContain('beta prompt');
    // Only the display prefix is shown; the full session id stays behind the
    // one-shot nonce the button carries.
    expect(rendered).toContain('mvs-alph');
    expect(rendered).toContain('mvs-beta');
    expect(rendered).not.toContain('mvs-alpha-secret');
    expect(rendered).not.toContain('mvs-beta-secret');

    const nonces = resumeArgsFromCard(card);
    expect(nonces).toHaveLength(2);
    await expect(h.run(`/resume use ${nonces[1]}`)).resolves.toBe(true);

    expect(h.catalog.activeFor(h.identity)).toMatchObject({
      sessionId: 'mvs-beta-secret',
    });
    expect(lastMarkdown(h.channel)).toContain('已完成');
  });

  it('resumes a mcode history selection from the card button callback', async () => {
    const h = await createHarness();
    h.history.push(mcodeSession('mvs-alpha-secret', 'alpha prompt', 1_700_000_100_000));

    await expect(h.run('/resume')).resolves.toBe(true);

    const [nonce] = resumeArgsFromCard(lastContent(h.channel));
    expect(nonce).toBeTypeOf('string');
    await h.dispatchResumeArg(nonce!);

    expect(h.catalog.activeFor(h.identity)).toMatchObject({
      sessionId: 'mvs-alpha-secret',
    });
    expect(lastMarkdown(h.channel)).toContain('已完成');
  });

  it('keeps mcode resume history details out of group chats', async () => {
    const h = await createHarness();
    h.history.push(mcodeSession('mvs-alpha-secret', 'alpha prompt', 1_700_000_100_000));

    await expect(h.run('/resume', { chatMode: 'group' })).resolves.toBe(true);

    const rendered = lastContentString(h.channel);
    expect(rendered).toContain('私聊');
    expect(rendered).not.toContain('alpha prompt');
    expect(rendered).not.toContain('mvs-alpha-secret');
  });

  it('labels /status with the session recorded by a resume', async () => {
    const h = await createHarness();

    await expect(h.run('/status')).resolves.toBe(true);
    let status = JSON.stringify(lastContent(h.channel));
    expect(status).toContain('**session**');
    expect(status).toContain('(无)');
    expect(status).not.toContain('**thread**');
    expect(status).not.toContain('**conversation**');

    h.history.push(mcodeSession('mvs-current', 'current prompt', 1_700_000_100_000));
    await expect(h.run('/resume')).resolves.toBe(true);
    const [nonce] = resumeArgsFromCard(lastContent(h.channel));
    await expect(h.run(`/resume use ${nonce}`)).resolves.toBe(true);

    await expect(h.run('/status')).resolves.toBe(true);
    status = JSON.stringify(lastContent(h.channel));
    expect(status).toContain('**session**');
    expect(status).toContain('mvs-curr');
    expect(status).not.toContain('(无)');
  });

  it('does not list local history from home when no workspace is bound', async () => {
    const h = await createHarness({ bindWorkspace: false, defaultWorkspace: false });

    await expect(h.run('/resume')).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('请先使用 /cd');
  });
});

async function createHarness(
  options: { bindWorkspace?: boolean; defaultWorkspace?: boolean } = {},
): Promise<Harness> {
  const tmp = await createTmpProfile('resume-command-mcode-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const catalog = new SessionCatalog(join(tmp.profile, 'session-catalog.json'));
  const history: McodeSessionSummary[] = [];
  const activeRuns = new ActiveRuns();
  const pending = new PendingQueue(60_000, () => {});
  const agent = createFakeAgent();
  const profileConfig = appConfig();
  if (options.defaultWorkspace !== false) {
    profileConfig.workspaces.default = tmp.workspace;
  }
  const controls = {
    profile: 'mcode',
    profileConfig,
    botOwnerId: 'ou-user',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath: join(tmp.profile, 'config.json'),
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;
  if (options.bindWorkspace !== false) {
    workspaces.setCwd('chat-1', tmp.workspace);
  }
  const identity = await commandIdentity(profileConfig, controls, tmp.workspace);
  const chatModeCache = {
    resolve: async () => 'p2p',
  } as unknown as ChatModeCache;

  const run = (
    content: string,
    runOptions: { withCatalogIdentity?: boolean; chatMode?: 'p2p' | 'group' | 'topic' } = {},
  ): Promise<boolean> =>
    tryHandleCommand({
      channel: channel as unknown as CommandContext['channel'],
      msg: message(content),
      scope: 'chat-1',
      chatMode: runOptions.chatMode ?? 'p2p',
      sessions,
      sessionCatalog: catalog,
      sessionCatalogIdentity: runOptions.withCatalogIdentity === false ? undefined : identity,
      workspaces,
      agent,
      activeRuns,
      controls,
      sessionHistoryProvider: () => history,
    });

  const dispatchResumeArg = (arg: string): Promise<void> =>
    handleCardAction({
      channel: channel as unknown as Parameters<typeof handleCardAction>[0]['channel'],
      evt: cardEvent({ cmd: 'resume.use', arg }),
      sessions,
      sessionCatalog: catalog,
      workspaces,
      activeRuns,
      agent,
      controls,
      pending,
      chatModeCache,
    });

  cleanups.push(async () => {
    pending.cancelAll();
    await Promise.all([sessions.flush(), workspaces.flush(), catalog.flush()]);
    await tmp.cleanup();
  });

  return {
    tmp,
    channel,
    sessions,
    workspaces,
    catalog,
    controls,
    identity,
    history,
    activeRuns,
    pending,
    run,
    dispatchResumeArg,
  };
}

function mcodeSession(
  sessionId: string,
  preview: string,
  mtime: number,
): McodeSessionSummary {
  return { sessionId, preview, mtime };
}

async function commandIdentity(
  profileConfig: ProfileConfig,
  controls: Controls,
  cwd: string,
): Promise<SessionCatalogIdentity> {
  const workspace = await resolveWorkingDirectory(cwd);
  if (!workspace.ok) throw new Error(workspace.userVisible);
  const capability = mcodeCapability(profileConfig);
  const access = canUseDm(profileConfig, controls, 'ou-user');
  const policy = evaluateRunPolicy({
    scope: {
      source: 'im',
      chatId: 'chat-1',
      actorId: 'ou-user',
    },
    attachments: [],
    prompt: '',
    requestedCwd: cwd,
    cwdRealpath: workspace.cwdRealpath,
    access,
    capability,
    profileConfig,
    now: Date.now(),
  });
  if (!policy.ok) throw new Error(policy.rejectReason.userVisible);
  return {
    scopeId: 'chat-1',
    agentId: capability.agentId,
    cwdRealpath: workspace.cwdRealpath,
    policyFingerprint: policy.policyFingerprint,
  };
}

function appConfig(): ProfileConfig {
  return createDefaultProfileConfig({
    agentKind: 'mcode',
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-user'] },
  });
}

function message(content: string): NormalizedMessage {
  return {
    messageId: `om-${content.replace(/\W+/g, '-').slice(0, 20)}`,
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId: 'ou-user',
    senderName: 'User',
    content,
    resources: [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}

function cardEvent(value: Record<string, unknown>): CardActionEvent {
  return {
    action: { value },
    chatId: 'chat-1',
    messageId: 'om-card',
    operator: {
      openId: 'ou-user',
      name: 'User',
    },
  } as unknown as CardActionEvent;
}

function lastMarkdown(channel: FakeChannel): string {
  const content = channel.sent.at(-1)?.content as { markdown?: unknown } | undefined;
  expect(content?.markdown).toBeTypeOf('string');
  return content?.markdown as string;
}

function lastContent(channel: FakeChannel): Record<string, unknown> {
  const content = channel.sent.at(-1)?.content;
  expect(content).toBeTypeOf('object');
  return content as Record<string, unknown>;
}

function lastContentString(channel: FakeChannel): string {
  return JSON.stringify(lastContent(channel));
}

function resumeArgsFromCard(card: unknown): string[] {
  const out: string[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const action = record.value as Record<string, unknown> | undefined;
    if (action?.cmd === 'resume.use' && typeof action.arg === 'string') out.push(action.arg);
    for (const child of Object.values(record)) {
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  };
  visit(card);
  return out;
}
