import { describe, expect, it } from 'vitest';
import {
  accessToMcodePolicy,
  clampAccess,
} from '../../../src/config/permissions';
import {
  createDefaultProfileConfig,
  effectiveLarkCliIdentity,
  normalizeProfileConfig,
} from '../../../src/config/profile-schema';

const app = {
  id: 'cli_test',
  secret: '${APP_SECRET}',
  tenant: 'feishu' as const,
};

describe('profile schema', () => {
  it('defaults mcode permissions to full/full without any sandbox or agent block', () => {
    const cfg = createDefaultProfileConfig({
      agentKind: 'mcode',
      accounts: { app },
    });

    expect(cfg.schemaVersion).toBe(2);
    expect(cfg.agentKind).toBe('mcode');
    expect(cfg.permissions).toMatchObject({
      defaultAccess: 'full',
      maxAccess: 'full',
    });
    expect(cfg).not.toHaveProperty('sandbox');
    expect(cfg.mcode).toBeUndefined();
  });

  it('defaults deployment mode to personal and parses team', () => {
    const fresh = createDefaultProfileConfig({ agentKind: 'mcode', accounts: { app } });
    expect(fresh.mode).toBe('personal');

    const team = createDefaultProfileConfig({ agentKind: 'mcode', mode: 'team', accounts: { app } });
    expect(team.mode).toBe('team');

    // Unknown / missing values normalize to personal (safe default for upgrades).
    const legacy = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'mcode',
      accounts: { app },
    });
    expect(legacy.mode).toBe('personal');
    const bogus = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'mcode',
      mode: 'nonsense',
      accounts: { app },
    });
    expect(bogus.mode).toBe('personal');
  });

  it('effectiveLarkCliIdentity forces bot-only in team mode and passes through otherwise', () => {
    expect(
      effectiveLarkCliIdentity({ mode: 'team', larkCli: { identityPreset: 'user-default' } }),
    ).toBe('bot-only');
    expect(
      effectiveLarkCliIdentity({ mode: 'personal', larkCli: { identityPreset: 'user-default' } }),
    ).toBe('user-default');
    expect(
      effectiveLarkCliIdentity({ mode: 'personal', larkCli: { identityPreset: 'bot-only' } }),
    ).toBe('bot-only');
  });

  it('rejects a retired agentKind and accepts only mcode', () => {
    expect(() =>
      normalizeProfileConfig({
        schemaVersion: 2,
        agentKind: 'codex',
        accounts: { app },
      }),
    ).toThrow(/agentKind must be mcode/);
    expect(() =>
      normalizeProfileConfig({
        schemaVersion: 2,
        agentKind: 'claude',
        accounts: { app },
      }),
    ).toThrow(/agentKind must be mcode/);
    expect(
      normalizeProfileConfig({
        schemaVersion: 2,
        agentKind: 'mcode',
        accounts: { app },
      }).agentKind,
    ).toBe('mcode');
  });

  it('keeps access at profile top level without legacy open semantics', () => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'mcode',
      accounts: { app },
      preferences: {
        messageReply: 'markdown',
      },
      access: {
        allowedUsers: [],
        allowedChats: [],
        admins: [],
      },
    });

    expect(cfg.preferences).not.toHaveProperty('access');
    expect(JSON.stringify(cfg)).not.toMatch(/access\.semantics|legacy-open|explicit/);
    expect(cfg.access).toEqual({
      allowedUsers: [],
      allowedChats: [],
      admins: [],
      requireMentionInGroup: true,
    });
  });

  it('drops invalid legacy message reply values instead of blocking config load', () => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'mcode',
      accounts: { app },
      preferences: {
        messageReply: 'plain-text',
        showToolCalls: false,
      } as never,
    });

    expect(cfg.preferences).toEqual({
      showToolCalls: false,
    });
  });

  it('normalizes workspaces to a default working directory only', () => {
    const cfg = createDefaultProfileConfig({
      agentKind: 'mcode',
      accounts: { app },
    });

    expect(cfg.workspaces).toEqual({});
  });

  it('defaults lark-cli identity to app-only without legacy global source fields', () => {
    const cfg = createDefaultProfileConfig({
      agentKind: 'mcode',
      accounts: { app },
    });

    expect(cfg.larkCli).toEqual({ identityPreset: 'bot-only' });
    expect(cfg.larkCli).not.toHaveProperty('configSource');
    expect(cfg.larkCli).not.toHaveProperty('workspaceMode');
  });

  it('normalizes lark-cli user identity import state without preserving invalid fields', () => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'mcode',
      accounts: { app },
      larkCli: {
        identityPreset: 'user-default',
        configSource: 'legacy-global',
        workspaceMode: 'shared',
        localUserImport: {
          status: 'imported',
          attemptedAt: '2026-06-04T01:02:03.000Z',
          importedAt: '2026-06-04T01:03:03.000Z',
          reason: 'same-app-local-user',
          token: 'must-not-survive',
        },
      },
    });

    expect(cfg.larkCli).toEqual({
      identityPreset: 'user-default',
      localUserImport: {
        status: 'imported',
        attemptedAt: '2026-06-04T01:02:03.000Z',
        importedAt: '2026-06-04T01:03:03.000Z',
        reason: 'same-app-local-user',
      },
    });
    expect(JSON.stringify(cfg.larkCli)).not.toContain('legacy-global');
    expect(JSON.stringify(cfg.larkCli)).not.toContain('workspaceMode');
    expect(JSON.stringify(cfg.larkCli)).not.toContain('token');
  });

  it('tolerates legacy workspace root fields without preserving them', () => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'mcode',
      accounts: { app },
      workspaces: {
        default: '/repo',
        trusted: ['/repo'],
        trustedRoots: ['/repo'],
        defaultWorkspaces: ['/repo'],
        riskFlags: ['legacy-home'],
      },
    });

    expect(cfg.workspaces).toEqual({ default: '/repo' });
  });

  it('drops comment config while tolerating legacy comment fields', () => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'mcode',
      accounts: { app },
      comments: {
        enabled: false,
        allowUsers: ['ou-user'],
        allowGroups: ['oc-chat'],
        allowlist: {
          docs: ['doc-b', 'doc-a', 'doc-a'],
          wikiSpaces: ['space-a'],
          folders: ['folder-a'],
        },
        bindings: {
          'doc-a': { workspace: '/repo/a', readOnly: true },
        },
        workspace: '/repo/comment',
        rateLimit: {
          perOperatorPerMin: 7,
          perDocPerMin: 13,
        },
      },
    });

    expect(cfg.comments).not.toHaveProperty('enabled');
    expect(cfg.comments).not.toHaveProperty('allowlist');
    expect(cfg.comments).not.toHaveProperty('allowUsers');
    expect(cfg.comments).not.toHaveProperty('allowGroups');
    expect(cfg.comments).not.toHaveProperty('allowedDocuments');
    expect(cfg.comments).not.toHaveProperty('bindings');
    expect(cfg.comments).not.toHaveProperty('workspace');
    expect(cfg.comments).not.toHaveProperty('rateLimit');
    expect(cfg.comments).toEqual({});
  });

  it('does not enable comment rate limits by default', () => {
    const cfg = createDefaultProfileConfig({
      agentKind: 'mcode',
      accounts: { app },
    });

    expect(cfg.comments).toEqual({});
  });

  it('seeds attachment limits from the runtime policy', () => {
    const cfg = createDefaultProfileConfig({
      agentKind: 'mcode',
      accounts: { app },
    });

    expect(cfg.attachments).toMatchObject({
      maxCount: 10,
      maxBytes: 100 * 1024 * 1024,
      maxFileBytes: 25 * 1024 * 1024,
      imageMaxBytes: 25 * 1024 * 1024,
    });
  });

  it('keeps only the pinned mcode binary path and drops legacy binary metadata', () => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'mcode',
      accounts: { app },
      mcode: {
        binaryPath: '/usr/local/bin/mcode',
        realpath: '/opt/mcode/bin/mcode',
        version: 'mcode 1.2.3',
        sha256: 'abc123',
        flags: ['--dangerously-skip-permissions'],
      } as never,
    });

    expect(cfg.mcode).toEqual({ binaryPath: '/usr/local/bin/mcode' });
    expect(cfg.mcode).not.toHaveProperty('flags');
  });

  it('lets canonical permissions win over stale legacy sandbox fields', () => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'mcode',
      accounts: { app },
      mcode: { binaryPath: '/usr/local/bin/mcode' },
      permissions: {
        defaultAccess: 'workspace',
        maxAccess: 'workspace',
      },
      sandbox: {
        defaultMode: 'danger-full-access',
        maxMode: 'danger-full-access',
      },
    } as never);

    expect(cfg.permissions).toMatchObject({
      defaultAccess: 'workspace',
      maxAccess: 'workspace',
    });
    expect(cfg).not.toHaveProperty('sandbox');
  });

  it('rejects permission defaults that exceed max access', () => {
    expect(() =>
      normalizeProfileConfig({
        schemaVersion: 2,
        agentKind: 'mcode',
        accounts: { app },
        permissions: {
          defaultAccess: 'full',
          maxAccess: 'workspace',
        },
      }),
    ).toThrow(/permission/i);
  });

  it('uses the mcode policy override when deriving the runtime policy', () => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'mcode',
      accounts: { app },
      permissions: {
        defaultAccess: 'full',
        maxAccess: 'full',
        mcode: {
          policy: 'off',
        },
      },
    });

    expect(accessToMcodePolicy('full', cfg.permissions)).toBe('off');
  });

  it('clamps access by both profile and capability maximums', () => {
    expect(clampAccess('full', 'workspace', 'full')).toBe('workspace');
    expect(clampAccess('workspace', 'full', 'read-only')).toBe('read-only');
    expect(clampAccess('read-only', 'full', 'full')).toBe('read-only');
  });

  it('keeps default access when canonical permissions only set the mcode override', () => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'mcode',
      accounts: { app },
      permissions: {
        mcode: {
          policy: 'smart',
        },
      },
    });

    expect(cfg.permissions).toMatchObject({
      defaultAccess: 'full',
      maxAccess: 'full',
      mcode: {
        policy: 'smart',
      },
    });
  });

  it('rejects mcode policy overrides wider than max access', () => {
    expect(() =>
      normalizeProfileConfig({
        schemaVersion: 2,
        agentKind: 'mcode',
        accounts: { app },
        permissions: {
          maxAccess: 'read-only',
          mcode: {
            policy: 'full',
          },
        },
      }),
    ).toThrow(/permission/i);
  });

  it('does not let the mcode policy override exceed the current access at runtime mapping time', () => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'mcode',
      accounts: { app },
      permissions: {
        defaultAccess: 'read-only',
        maxAccess: 'full',
        mcode: {
          policy: 'full',
        },
      },
    });

    expect(accessToMcodePolicy('read-only', cfg.permissions)).toBe('off');
  });

  it('rejects array-shaped permissions config', () => {
    expect(() =>
      normalizeProfileConfig({
        schemaVersion: 2,
        agentKind: 'mcode',
        accounts: { app },
        permissions: [],
      }),
    ).toThrow(/permission/i);
  });

  it('rejects array-shaped mcode permissions config', () => {
    expect(() =>
      normalizeProfileConfig({
        schemaVersion: 2,
        agentKind: 'mcode',
        accounts: { app },
        permissions: {
          mcode: [],
        },
      }),
    ).toThrow(/permission/i);
  });

  it('clamps default access from full defaults when only canonical max access is explicit', () => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'mcode',
      accounts: { app },
      permissions: {
        maxAccess: 'workspace',
      },
    });

    expect(cfg.permissions).toMatchObject({
      defaultAccess: 'workspace',
      maxAccess: 'workspace',
    });
  });
});
