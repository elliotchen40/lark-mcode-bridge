import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  materializeEnvSecretForService,
  resolveProfileRuntime,
} from '../../../src/runtime/profile-runtime';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { getSecret } from '../../../src/config/keystore';
import { secretKeyForApp } from '../../../src/config/schema';
import { legacyLarkCliSourceOverlayPaths } from '../../../src/lark-cli/legacy-source-overlay';
import { writeLarkCliSourceProjection } from '../../../src/lark-cli/profile-projection';
import { writeVersionExecutable } from '../../helpers/fake-executable';

const wizard = vi.hoisted(() => ({
  next: {
    accounts: {
      app: {
        id: 'cli_wizard',
        secret: 'wizard-secret',
        tenant: 'feishu' as const,
      },
    },
    preferences: {},
  },
}));

const auth = vi.hoisted(() => {
  type ValidationMockResult = { ok: boolean; botName?: string; reason?: string };
  return {
    validateAppCredentials: vi.fn(
      async (): Promise<ValidationMockResult> => ({ ok: true, botName: 'Bridge Bot' }),
    ),
  };
});

vi.mock('../../../src/bot/wizard', () => ({
  runRegistrationWizard: vi.fn(async () => wizard.next),
}));

vi.mock('../../../src/utils/feishu-auth', () => ({
  validateAppCredentials: auth.validateAppCredentials,
}));

const app = {
  id: 'cli_test',
  secret: '${APP_SECRET}',
  tenant: 'feishu' as const,
};

describe('profile runtime resolver', () => {
  it('recovers a crashed legacy lark-cli source overlay before loading the root config', async () => {
    const root = await tmpRoot();
    const configFile = join(root, 'config.json');
    const { backupFile, markerFile } = legacyLarkCliSourceOverlayPaths(configFile);
    const original = `${JSON.stringify({
      schemaVersion: 2,
      activeProfile: 'mcode',
      profiles: {
        mcode: createDefaultProfileConfig({
          agentKind: 'mcode',
          accounts: { app },
          mcode: { binaryPath: 'mcode' },
        }),
      },
    }, null, 2)}\n`;
    const overlay = `${JSON.stringify({ accounts: { app: { id: 'cli_overlay' } } }, null, 2)}\n`;
    await writeFile(backupFile, original, { mode: 0o600 });
    await writeFile(markerFile, `${JSON.stringify({ hadConfig: true, profile: 'mcode' })}\n`, {
      mode: 0o600,
    });
    await writeFile(configFile, overlay, { mode: 0o600 });

    const runtime = await resolveProfileRuntime({
      config: configFile,
      profile: 'mcode',
      allowBootstrap: false,
    });

    expect(runtime.profile).toBe('mcode');
    const recovered = JSON.parse(await readFile(configFile, 'utf8')) as {
      schemaVersion?: number;
      profiles?: Record<string, unknown>;
      accounts?: unknown;
    };
    expect(recovered.schemaVersion).toBe(2);
    expect(recovered.profiles?.mcode).toBeTruthy();
    expect(recovered.accounts).toBeUndefined();
    await expect(readFile(backupFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(markerFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails clearly when no supported local agent is installed', async () => {
    const root = await tmpRoot();
    const bin = join(root, 'bin');
    const oldPath = process.env.PATH;
    const oldMcode = process.env.LARK_CHANNEL_MCODE_BIN;
    process.env.PATH = bin;
    delete process.env.LARK_CHANNEL_MCODE_BIN;

    try {
      await expect(
        resolveProfileRuntime({
          config: join(root, 'config.json'),
          allowBootstrap: true,
        }),
      ).rejects.toThrow(/no supported local agent found/);
    } finally {
      process.env.PATH = oldPath;
      if (oldMcode === undefined) {
        delete process.env.LARK_CHANNEL_MCODE_BIN;
      } else {
        process.env.LARK_CHANNEL_MCODE_BIN = oldMcode;
      }
    }
  });

  it('bootstraps first-run profile from existing app credentials without QR registration', async () => {
    const root = await tmpRoot();
    const workspace = join(root, 'workspace');
    await mkdir(join(workspace, '.git'), { recursive: true });

    const runtime = await resolveProfileRuntime({
      config: join(root, 'config.json'),
      agent: 'mcode',
      workspace,
      allowBootstrap: true,
      appId: 'cli_existing',
      appSecret: 'manual-secret',
      tenant: 'feishu',
    } as Parameters<typeof resolveProfileRuntime>[0] & {
      appId: string;
      appSecret: string;
      tenant: 'feishu';
    });

    const savedText = await readFile(join(root, 'config.json'), 'utf8');
    const saved = JSON.parse(savedText) as {
      activeProfile: string;
      profiles: Record<string, { accounts: { app: { id: string; secret: unknown } } }>;
      secrets?: { providers?: Record<string, { command?: string }> };
    };
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'mcode' });
    const secret = await getSecret(secretKeyForApp('cli_existing'), appPaths);
    const workspaceRealpath = await realpath(workspace);

    expect(auth.validateAppCredentials).toHaveBeenCalledWith(
      'cli_existing',
      'manual-secret',
      'feishu',
    );
    expect(runtime.profile).toBe('mcode');
    expect(runtime.profileConfig.workspaces.default).toBe(workspaceRealpath);
    expect(saved.activeProfile).toBe('mcode');
    expect(saved.profiles.mcode?.accounts.app.id).toBe('cli_existing');
    expect(saved.profiles.mcode?.accounts.app.secret).toEqual({
      source: 'exec',
      provider: 'bridge',
      id: 'app-cli_existing',
    });
    expect(saved.secrets?.providers?.bridge?.command).toBe(expectedSecretsGetter(root));
    expect(savedText).not.toContain('manual-secret');
    expect(secret).toBe('manual-secret');
  });

  it('rejects existing app bootstrap without writing config when credentials are invalid', async () => {
    const root = await tmpRoot();
    const workspace = join(root, 'workspace');
    await mkdir(join(workspace, '.git'), { recursive: true });
    auth.validateAppCredentials.mockResolvedValueOnce({ ok: false, reason: 'code=999' });

    await expect(
      resolveProfileRuntime({
        config: join(root, 'config.json'),
        agent: 'mcode',
        workspace,
        allowBootstrap: true,
        appId: 'cli_bad',
        appSecret: 'bad-secret',
        tenant: 'feishu',
      } as Parameters<typeof resolveProfileRuntime>[0] & {
        appId: string;
        appSecret: string;
        tenant: 'feishu';
      }),
    ).rejects.toThrow(/code=999/);
    await expect(readFile(join(root, 'config.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('fails clearly instead of opening the QR wizard during non-interactive first run', async () => {
    const root = await tmpRoot();

    await withTty(false, false, async () => {
      await expect(
        resolveProfileRuntime({
          config: join(root, 'config.json'),
          agent: 'mcode',
          allowBootstrap: true,
        }),
      ).rejects.toThrow(/非交互模式无法完成扫码创建应用/);
    });

    await expect(readFile(join(root, 'config.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('fails clearly when non-interactive existing-app bootstrap omits the app secret', async () => {
    const root = await tmpRoot();

    await withTty(false, false, async () => {
      await expect(
        resolveProfileRuntime({
          config: join(root, 'config.json'),
          agent: 'mcode',
          allowBootstrap: true,
          appId: 'cli_missing_secret',
          tenant: 'feishu',
        }),
      ).rejects.toThrow(/非交互模式缺少 App Secret/);
    });

    await expect(readFile(join(root, 'config.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('bootstraps a managed default workspace when no workspace is provided', async () => {
    const root = await tmpRoot();

    const runtime = await resolveProfileRuntime({
      config: join(root, 'config.json'),
      agent: 'mcode',
      allowBootstrap: true,
      appId: 'cli_existing',
      appSecret: 'manual-secret',
      tenant: 'feishu',
    } as Parameters<typeof resolveProfileRuntime>[0] & {
      appId: string;
      appSecret: string;
      tenant: 'feishu';
    });

    const managed = await realpath(resolveAppPaths({ rootDir: root, profile: 'mcode' }).defaultWorkspaceDir);
    const savedText = await readFile(join(root, 'config.json'), 'utf8');
    const saved = JSON.parse(savedText) as {
      profiles: Record<string, { workspaces?: { default?: string } }>;
    };
    expect(runtime.profileConfig.workspaces.default).toBe(managed);
    expect(saved.profiles.mcode?.workspaces?.default).toBe(managed);
  });

  it('bootstraps first-run with the single detected local agent', async () => {
    const root = await tmpRoot();
    const bin = join(root, 'bin');
    const mcode = await writeExecutable(bin, 'mcode');
    const oldPath = process.env.PATH;
    const oldMcode = process.env.LARK_CHANNEL_MCODE_BIN;
    process.env.PATH = bin;
    delete process.env.LARK_CHANNEL_MCODE_BIN;

    try {
      const runtime = await withTty(true, true, () =>
        resolveProfileRuntime({
          config: join(root, 'config.json'),
          allowBootstrap: true,
        }),
      );

      expect(runtime.profile).toBe('mcode');
      expect(runtime.profileConfig.agentKind).toBe('mcode');
      expect(runtime.profileConfig.mcode?.binaryPath).toBe(mcode);
    } finally {
      process.env.PATH = oldPath;
      if (oldMcode === undefined) {
        delete process.env.LARK_CHANNEL_MCODE_BIN;
      } else {
        process.env.LARK_CHANNEL_MCODE_BIN = oldMcode;
      }
    }
  });

  it('adds a managed default workspace when converting an explicit legacy config', async () => {
    const root = await tmpRoot();
    await writeFile(
      join(root, 'config.json'),
      `${JSON.stringify({
        accounts: { app },
        preferences: {},
      }, null, 2)}\n`,
    );

    const runtime = await resolveProfileRuntime({
      config: join(root, 'config.json'),
      agent: 'mcode',
      allowBootstrap: true,
    });

    const managed = await realpath(resolveAppPaths({ rootDir: root, profile: 'mcode' }).defaultWorkspaceDir);
    const savedText = await readFile(join(root, 'config.json'), 'utf8');
    const saved = JSON.parse(savedText) as {
      profiles: Record<string, { workspaces?: { default?: string } }>;
    };
    expect(runtime.profileConfig.workspaces.default).toBe(managed);
    expect(saved.profiles.mcode?.workspaces?.default).toBe(managed);
  });

  it('uses a requested workspace when converting an explicit legacy config', async () => {
    const root = await tmpRoot();
    const workspace = join(root, 'requested-workspace');
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(root, 'config.json'),
      `${JSON.stringify({
        accounts: { app },
        preferences: {},
      }, null, 2)}\n`,
    );

    const runtime = await resolveProfileRuntime({
      config: join(root, 'config.json'),
      agent: 'mcode',
      workspace,
      allowBootstrap: true,
    });

    const workspaceRealpath = await realpath(workspace);
    expect(runtime.profileConfig.workspaces.default).toBe(workspaceRealpath);
  });

  it('migrates an origin-main v1 config to canonical profile permissions without stored sandbox', async () => {
    const root = await tmpRoot();
    const workspace = join(root, 'requested-workspace');
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(root, 'config.json'),
      `${JSON.stringify({
        accounts: { app },
        preferences: {
          messageReply: 'card',
          showToolCalls: false,
          maxConcurrentRuns: 3,
          requireMentionInGroup: false,
          access: {
            allowedUsers: ['ou_allowed'],
            allowedChats: ['oc_allowed'],
            admins: ['ou_admin'],
          },
        },
      }, null, 2)}\n`,
    );

    const runtime = await resolveProfileRuntime({
      config: join(root, 'config.json'),
      profile: 'mcode',
      workspace,
      allowBootstrap: false,
    });
    const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as {
      profiles: Record<string, {
        permissions?: unknown;
        sandbox?: unknown;
        access?: unknown;
        preferences?: unknown;
      }>;
    };

    expect(runtime.profileConfig.permissions).toEqual({
      defaultAccess: 'full',
      maxAccess: 'full',
    });
    expect(runtime.profileConfig.access).toEqual({
      allowedUsers: ['ou_allowed'],
      allowedChats: ['oc_allowed'],
      admins: ['ou_admin'],
      requireMentionInGroup: false,
    });
    expect(runtime.profileConfig.preferences).toMatchObject({
      messageReply: 'card',
      showToolCalls: false,
      maxConcurrentRuns: 3,
    });
    expect(saved.profiles.mcode?.permissions).toEqual({
      defaultAccess: 'full',
      maxAccess: 'full',
    });
    expect(saved.profiles.mcode).not.toHaveProperty('sandbox');
    expect(saved.profiles.mcode?.access).toEqual({
      allowedUsers: ['ou_allowed'],
      allowedChats: ['oc_allowed'],
      admins: ['ou_admin'],
      requireMentionInGroup: false,
    });
    expect(saved.profiles.mcode?.preferences).toMatchObject({
      messageReply: 'card',
      showToolCalls: false,
      maxConcurrentRuns: 3,
    });
  });

  it('uses the requested agent when migrating a legacy config into an explicit profile', async () => {
    const root = await tmpRoot();
    const bin = join(root, 'bin');
    const mcode = await writeExecutable(bin, 'mcode');
    const oldPath = process.env.PATH;
    const oldHome = process.env.LARK_CHANNEL_HOME;
    process.env.PATH = `${bin}${delimiter}${oldPath ?? ''}`;
    process.env.LARK_CHANNEL_HOME = root;
    await writeFile(
      join(root, 'config.json'),
      `${JSON.stringify({
        accounts: { app },
        preferences: {},
      }, null, 2)}\n`,
    );

    try {
      const runtime = await resolveProfileRuntime({
        profile: 'mcode',
        agent: 'mcode',
        allowBootstrap: true,
      });
      const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as {
        profiles: Record<string, { agentKind: string; mcode?: { binaryPath?: string } }>;
      };

      expect(runtime.profile).toBe('mcode');
      expect(runtime.profileConfig.agentKind).toBe('mcode');
      expect(runtime.profileConfig.mcode?.binaryPath).toBe(mcode);
      expect(saved.profiles.mcode?.agentKind).toBe('mcode');
      expect(saved.profiles.mcode?.mcode?.binaryPath).toBe(mcode);
    } finally {
      process.env.PATH = oldPath;
      if (oldHome === undefined) {
        delete process.env.LARK_CHANNEL_HOME;
      } else {
        process.env.LARK_CHANNEL_HOME = oldHome;
      }
    }
  });

  it('runs the same v2 migration for explicit config paths', async () => {
    const root = await tmpRoot();
    const bin = join(root, 'bin');
    const mcode = await writeExecutable(bin, 'mcode');
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${oldPath ?? ''}`;
    await writeFile(
      join(root, 'config.json'),
      `${JSON.stringify({
        accounts: { app },
        preferences: {},
      }, null, 2)}\n`,
    );
    await writeFile(
      join(root, 'sessions.json'),
      `${JSON.stringify({ chat_a: { threadId: 'thread-1' } }, null, 2)}\n`,
    );

    try {
      const runtime = await resolveProfileRuntime({
        config: join(root, 'config.json'),
        profile: 'mcode',
        agent: 'mcode',
        allowBootstrap: true,
      });

      expect(runtime.profileConfig.agentKind).toBe('mcode');
      // v2 migration pins only the binary path; no probed metadata is stored.
      expect(runtime.profileConfig.mcode).toEqual({ binaryPath: mcode });
      await expect(readFile(join(root, 'profiles', 'mcode', 'sessions.json'), 'utf8')).resolves
        .toContain('thread-1');
      await expect(readFile(join(root, 'sessions.json'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      process.env.PATH = oldPath;
    }
  });

  it('imports a valid legacy workspace when converting an explicit legacy config', async () => {
    const root = await tmpRoot();
    const workspace = join(root, 'legacy-workspace');
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(root, 'config.json'),
      `${JSON.stringify({
        accounts: { app },
        preferences: {},
      }, null, 2)}\n`,
    );
    await writeFile(
      join(root, 'workspaces.json'),
      `${JSON.stringify({
        chats: { chat_a: { cwd: workspace } },
        named: {},
      }, null, 2)}\n`,
    );

    const runtime = await resolveProfileRuntime({
      config: join(root, 'config.json'),
      agent: 'mcode',
      allowBootstrap: true,
    });

    const workspaceRealpath = await realpath(workspace);
    expect(runtime.profileConfig.workspaces.default).toBe(workspaceRealpath);
  });

  it('resolves the active profile from a v2 root config', async () => {
    const root = await tmpRoot();
    await writeProfileRoot(root, 'mcode-dev', {
      work: createDefaultProfileConfig({ agentKind: 'mcode', accounts: { app } }),
      'mcode-dev': createDefaultProfileConfig({
        agentKind: 'mcode',
        accounts: { app: { ...app, id: 'cli_mcode' } },
        mcode: { binaryPath: '/usr/local/bin/mcode' },
      }),
    });

    const runtime = await resolveProfileRuntime({ config: join(root, 'config.json') });

    expect(runtime.profile).toBe('mcode-dev');
    expect(runtime.profileConfig.agentKind).toBe('mcode');
    expect(runtime.appPaths.profileDir).toBe(join(root, 'profiles', 'mcode-dev'));
  });

  it('stamps the permission-defaults migration marker without widening stored permissions', async () => {
    const root = await tmpRoot();
    const mcode = createDefaultProfileConfig({
      agentKind: 'mcode',
      accounts: { app },
      permissions: {
        defaultAccess: 'workspace',
        maxAccess: 'workspace',
      },
    });
    await writeProfileRoot(root, 'mcode', { mcode });

    const runtime = await resolveProfileRuntime({ config: join(root, 'config.json') });
    const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as {
      migrations?: { permissionDefaultsV1?: string[] };
      profiles: Record<string, { permissions?: unknown; sandbox?: unknown }>;
    };

    expect(runtime.profileConfig.permissions).toEqual({
      defaultAccess: 'workspace',
      maxAccess: 'workspace',
    });
    expect(saved.profiles.mcode?.permissions).toEqual({
      defaultAccess: 'workspace',
      maxAccess: 'workspace',
    });
    expect(saved.profiles.mcode).not.toHaveProperty('sandbox');
    expect(saved.migrations?.permissionDefaultsV1).toContain('mcode');
  });

  it('keeps marked canonical workspace permissions for users who lower access after migration', async () => {
    const root = await tmpRoot();
    const mcode = createDefaultProfileConfig({
      agentKind: 'mcode',
      accounts: { app },
      permissions: {
        defaultAccess: 'workspace',
        maxAccess: 'workspace',
      },
    });
    await writeProfileRoot(root, 'mcode', { mcode }, {
      migrations: { permissionDefaultsV1: ['mcode'] },
    });

    const runtime = await resolveProfileRuntime({ config: join(root, 'config.json') });
    const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as {
      migrations?: { permissionDefaultsV1?: string[] };
      profiles: Record<string, { permissions?: unknown; sandbox?: unknown }>;
    };

    expect(runtime.profileConfig.permissions).toEqual({
      defaultAccess: 'workspace',
      maxAccess: 'workspace',
    });
    expect(saved.profiles.mcode?.permissions).toEqual({
      defaultAccess: 'workspace',
      maxAccess: 'workspace',
    });
    expect(saved.profiles.mcode).not.toHaveProperty('sandbox');
    expect(saved.migrations?.permissionDefaultsV1).toContain('mcode');
  });

  it('keeps unmarked canonical workspace permissions with an mcode policy override as explicit lower access', async () => {
    const root = await tmpRoot();
    const mcode = createDefaultProfileConfig({
      agentKind: 'mcode',
      accounts: { app },
      permissions: {
        defaultAccess: 'workspace',
        maxAccess: 'workspace',
        mcode: {
          policy: 'smart',
        },
      },
    });
    await writeProfileRoot(root, 'mcode', { mcode });

    const runtime = await resolveProfileRuntime({ config: join(root, 'config.json') });
    const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as {
      migrations?: { permissionDefaultsV1?: string[] };
      profiles: Record<string, { permissions?: unknown; sandbox?: unknown }>;
    };

    expect(runtime.profileConfig.permissions).toEqual({
      defaultAccess: 'workspace',
      maxAccess: 'workspace',
      mcode: {
        policy: 'smart',
      },
    });
    expect(saved.profiles.mcode?.permissions).toEqual({
      defaultAccess: 'workspace',
      maxAccess: 'workspace',
      mcode: {
        policy: 'smart',
      },
    });
    expect(saved.profiles.mcode).not.toHaveProperty('sandbox');
    expect(saved.migrations?.permissionDefaultsV1).toContain('mcode');
  });

  it('keeps explicit canonical lower permissions when resolving an existing profile', async () => {
    const root = await tmpRoot();
    const mcode = createDefaultProfileConfig({
      agentKind: 'mcode',
      accounts: { app },
      permissions: {
        defaultAccess: 'read-only',
        maxAccess: 'read-only',
      },
    });
    await writeProfileRoot(root, 'mcode', { mcode });

    const runtime = await resolveProfileRuntime({ config: join(root, 'config.json') });
    const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as {
      profiles: Record<string, {
        permissions?: unknown;
        sandbox?: unknown;
        permissionSource?: unknown;
      }>;
    };

    expect(runtime.profileConfig.permissions).toEqual({
      defaultAccess: 'read-only',
      maxAccess: 'read-only',
    });
    expect(runtime.profileConfig).not.toHaveProperty('sandbox');
    expect(saved.profiles.mcode?.permissions).toEqual({
      defaultAccess: 'read-only',
      maxAccess: 'read-only',
    });
    expect(saved.profiles.mcode).not.toHaveProperty('sandbox');
    expect(saved.profiles.mcode).not.toHaveProperty('permissionSource');
  });

  it('creates a managed default workspace for profiles without a default', async () => {
    const root = await tmpRoot();
    const profile = createDefaultProfileConfig({
      agentKind: 'mcode',
      accounts: { app },
    });
    profile.workspaces = {};
    await writeProfileRoot(root, 'mcode', { mcode: profile });

    const runtime = await resolveProfileRuntime({ config: join(root, 'config.json') });

    const managed = await realpath(resolveAppPaths({ rootDir: root, profile: 'mcode' }).defaultWorkspaceDir);
    expect(runtime.profileConfig.workspaces.default).toBe(managed);
  });

  it('lets an explicit profile override active-profile', async () => {
    const root = await tmpRoot();
    await writeProfileRoot(root, 'mcode-dev', {
      work: createDefaultProfileConfig({ agentKind: 'mcode', accounts: { app } }),
      'mcode-dev': createDefaultProfileConfig({
        agentKind: 'mcode',
        accounts: { app: { ...app, id: 'cli_mcode' } },
        mcode: { binaryPath: '/usr/local/bin/mcode' },
      }),
    });

    const runtime = await resolveProfileRuntime({
      config: join(root, 'config.json'),
      profile: 'work',
    });

    expect(runtime.profile).toBe('work');
    expect(runtime.profileConfig.agentKind).toBe('mcode');
  });

  it('fails when active-profile points at a missing profile instead of falling back', async () => {
    const root = await tmpRoot();
    await writeProfileRoot(root, 'missing-profile', {
      work: createDefaultProfileConfig({ agentKind: 'mcode', accounts: { app } }),
    });

    await expect(
      resolveProfileRuntime({ config: join(root, 'config.json') }),
    ).rejects.toThrow(/profile not found/i);
  });

  it('bootstraps an explicit missing profile into an existing v2 root config', async () => {
    const root = await tmpRoot();
    const workspace = join(root, 'workspace');
    await mkdir(join(workspace, '.git'), { recursive: true });
    await writeProfileRoot(root, 'mcode-dev', {
      'mcode-dev': createDefaultProfileConfig({
        agentKind: 'mcode',
        accounts: { app: { ...app, id: 'cli_mcode' } },
        mcode: { binaryPath: '/usr/local/bin/mcode' },
      }),
    });
    wizard.next = {
      accounts: {
        app: {
          id: 'cli_mcode_regression',
          secret: 'new-profile-secret',
          tenant: 'feishu',
        },
      },
      preferences: {},
    };

    const runtime = await withTty(true, true, () =>
      resolveProfileRuntime({
        config: join(root, 'config.json'),
        profile: 'mcode-regression',
        agent: 'mcode',
        workspace,
        allowBootstrap: true,
      }),
    );
    const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as {
      activeProfile: string;
      profiles: Record<string, { agentKind: string; accounts: { app: { id: string } } }>;
    };
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'mcode-regression' });
    const secret = await getSecret(secretKeyForApp('cli_mcode_regression'), appPaths);
    const workspaceRealpath = await realpath(workspace);

    expect(runtime.profile).toBe('mcode-regression');
    expect(runtime.profileConfig.agentKind).toBe('mcode');
    expect(runtime.profileConfig.workspaces.default).toBe(workspaceRealpath);
    expect(saved.activeProfile).toBe('mcode-dev');
    await expect(readFile(join(root, 'active-profile'), 'utf8')).resolves.toBe('mcode-dev\n');
    expect(saved.profiles['mcode-dev']?.agentKind).toBe('mcode');
    expect(saved.profiles['mcode-regression']?.agentKind).toBe('mcode');
    expect(saved.profiles['mcode-regression']?.accounts.app.id).toBe('cli_mcode_regression');
    expect(secret).toBe('new-profile-secret');
  });

  it('normalizes stored v2 profiles before exposing runtime config', async () => {
    const root = await tmpRoot();
    const mcode = createDefaultProfileConfig({
      agentKind: 'mcode',
      accounts: { app: { ...app, id: 'cli_mcode' } },
      mcode: { binaryPath: '/usr/local/bin/mcode' },
    }) as unknown as Record<string, unknown>;
    mcode.mcode = {
      ...(mcode.mcode as Record<string, unknown>),
      flags: ['--dangerously-skip-permissions'],
    };
    mcode.workspaces = {
      default: '/repo/project',
      trustedRoots: ['/repo'],
    };
    await writeProfileRoot(root, 'mcode-dev', { 'mcode-dev': mcode });

    const runtime = await resolveProfileRuntime({ config: join(root, 'config.json') });

    expect(runtime.profileConfig.workspaces.default).toBe('/repo/project');
    expect(runtime.profileConfig.workspaces).not.toHaveProperty('trustedRoots');
    expect(runtime.profileConfig.mcode).toEqual({ binaryPath: '/usr/local/bin/mcode' });
    expect(runtime.profileConfig.mcode).not.toHaveProperty('flags');
  });

  it('materializes env-backed secrets into encrypted profile storage for service mode', async () => {
    const root = await tmpRoot();
    process.env.BRIDGE_TEST_APP_SECRET = 'service-mode-secret';
    await writeProfileRoot(root, 'mcode-dev', {
      'mcode-dev': createDefaultProfileConfig({
        agentKind: 'mcode',
        accounts: {
          app: {
            id: 'cli_mcode',
            secret: { source: 'env', id: 'BRIDGE_TEST_APP_SECRET' },
            tenant: 'feishu',
          },
        },
        mcode: { binaryPath: '/usr/local/bin/mcode' },
      }),
    });

    const changed = await materializeEnvSecretForService({
      config: join(root, 'config.json'),
      profile: 'mcode-dev',
    });

    const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as {
      profiles: Record<string, { accounts: { app: { secret: unknown } } }>;
      secrets?: { providers?: Record<string, { command?: string }> };
    };
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'mcode-dev' });
    const secret = await getSecret(secretKeyForApp('cli_mcode'), appPaths);
    const runtime = await resolveProfileRuntime({
      config: join(root, 'config.json'),
      profile: 'mcode-dev',
      allowBootstrap: false,
    });
    const projectionPath = await writeLarkCliSourceProjection(runtime.cfg, appPaths);
    const projectionText = await readFile(projectionPath, 'utf8');
    const projection = JSON.parse(projectionText) as {
      accounts: { app: { secret: unknown } };
      secrets?: { providers?: Record<string, { command?: string; env?: Record<string, string> }> };
    };

    expect(changed).toBe(true);
    expect(saved.profiles['mcode-dev']?.accounts.app.secret).toEqual({
      source: 'exec',
      provider: 'bridge',
      id: 'app-cli_mcode',
    });
    expect(saved.secrets?.providers?.bridge?.command).toBe(expectedSecretsGetter(root));
    expect(secret).toBe('service-mode-secret');
    expect(projectionText).not.toContain('${BRIDGE_TEST_APP_SECRET}');
    expect(projection.accounts.app.secret).toEqual({
      source: 'exec',
      provider: 'bridge',
      id: 'app-cli_mcode',
    });
    expect(projection.secrets?.providers?.bridge?.command).toBe(expectedSecretsGetter(root));
    expect(projection.secrets?.providers?.bridge?.env).toMatchObject({
      LARK_CHANNEL_HOME: root,
      LARK_CHANNEL_PROFILE: 'mcode-dev',
    });
  });
});

async function tmpRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'bridge-profile-runtime-'));
}

async function writeExecutable(root: string, name: string): Promise<string> {
  return writeVersionExecutable(root, name, 'ok');
}

function expectedSecretsGetter(root: string): string {
  const script = join(root, 'secrets-getter');
  return process.platform === 'win32' ? `${script}.cmd` : script;
}

async function writeProfileRoot(
  root: string,
  activeProfile: string,
  profiles: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'config.json'),
    `${JSON.stringify({
      schemaVersion: 2,
      activeProfile,
      preferences: {},
      ...extra,
      profiles,
    }, null, 2)}\n`,
  );
  await writeFile(join(root, 'active-profile'), `${activeProfile}\n`);
}

async function withTty<T>(
  stdinTTY: boolean,
  stdoutTTY: boolean,
  fn: () => Promise<T>,
): Promise<T> {
  const stdinDesc = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const stdoutDesc = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: stdinTTY });
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: stdoutTTY });
  try {
    return await fn();
  } finally {
    restoreDescriptor(process.stdin, 'isTTY', stdinDesc);
    restoreDescriptor(process.stdout, 'isTTY', stdoutDesc);
  }
}

function restoreDescriptor(
  target: NodeJS.ReadStream | NodeJS.WriteStream,
  key: 'isTTY',
  desc: PropertyDescriptor | undefined,
): void {
  if (desc) {
    Object.defineProperty(target, key, desc);
  } else {
    delete (target as unknown as Record<string, unknown>)[key];
  }
}
