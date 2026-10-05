import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runProfileCreate } from '../../../src/cli/commands/profile';
import { resolveAppPaths } from '../../../src/config/app-paths';
import {
  createDefaultProfileConfig,
  type RootConfig,
} from '../../../src/config/profile-schema';
import { loadRootConfig } from '../../../src/config/profile-store';
import { getSecret } from '../../../src/config/keystore';
import { secretKeyForApp } from '../../../src/config/schema';
import { writeVersionExecutable } from '../../helpers/fake-executable';

const auth = vi.hoisted(() => ({
  validateAppCredentials: vi.fn(async () => ({ ok: true, botName: 'Bridge Bot' })),
}));

vi.mock('../../../src/utils/feishu-auth', () => ({
  validateAppCredentials: auth.validateAppCredentials,
}));

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('profile create command', () => {
  it('creates a named profile from existing app credentials in an initialized root', async () => {
    const root = await makeRoot();
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    await writeProfiles(root, 'existing', ['existing']);

    await runProfileCreate('new-profile', {
      rootDir: root,
      agent: 'mcode',
      workspace,
      appId: 'cli_new_profile',
      appSecret: 'manual-secret',
      tenant: 'feishu',
    });

    const savedText = await readFile(join(root, 'config.json'), 'utf8');
    const saved = JSON.parse(savedText) as RootConfig;
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'new-profile' });
    const secret = await getSecret(secretKeyForApp('cli_new_profile'), appPaths);
    const workspaceRealpath = await realpath(workspace);

    expect(auth.validateAppCredentials).toHaveBeenCalledWith(
      'cli_new_profile',
      'manual-secret',
      'feishu',
    );
    expect(saved.activeProfile).toBe('existing');
    await expect(readFile(join(root, 'active-profile'), 'utf8')).resolves.toBe('existing\n');
    expect(saved.profiles['existing']?.agentKind).toBe('mcode');
    expect(saved.profiles['new-profile']?.agentKind).toBe('mcode');
    expect(saved.profiles['new-profile']?.workspaces.default).toBe(workspaceRealpath);
    expect(savedText).not.toContain('manual-secret');
    expect(secret).toBe('manual-secret');
  });

  it('creates a named mcode profile that can write inside the default workspace by default', async () => {
    const root = await makeRoot();
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    await writeProfiles(root, 'existing', ['existing']);
    const mcode = await writeVersionExecutable(root, 'mcode', 'mcode 1.2.3');
    const oldMcodeBin = process.env.LARK_CHANNEL_MCODE_BIN;
    process.env.LARK_CHANNEL_MCODE_BIN = mcode;

    try {
      await runProfileCreate('mcode-dev', {
        rootDir: root,
        agent: 'mcode',
        workspace,
        appId: 'cli_mcode_dev',
        appSecret: 'manual-secret',
        tenant: 'feishu',
      });
    } finally {
      if (oldMcodeBin === undefined) {
        delete process.env.LARK_CHANNEL_MCODE_BIN;
      } else {
        process.env.LARK_CHANNEL_MCODE_BIN = oldMcodeBin;
      }
    }

    const configPath = join(root, 'config.json');
    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    expect(saved.profiles['mcode-dev']?.agentKind).toBe('mcode');
    expect(saved.profiles['mcode-dev']).not.toHaveProperty('sandbox');

    const loaded = await loadRootConfig(configPath);
    expect(loaded?.profiles['mcode-dev']?.permissions).toEqual({
      defaultAccess: 'full',
      maxAccess: 'full',
    });
    expect(loaded?.profiles['mcode-dev']?.mcode).toEqual({ binaryPath: mcode });
  });

  it('refuses to overwrite an existing profile', async () => {
    const root = await makeRoot();
    await writeProfiles(root, 'existing', ['existing']);

    await expect(
      runProfileCreate('existing', {
        rootDir: root,
        agent: 'mcode',
        appId: 'cli_other',
        appSecret: 'manual-secret',
      }),
    ).rejects.toThrow(/profile already exists/);
  });

  it('creates a named profile without requiring a user workspace', async () => {
    const root = await makeRoot();
    await writeProfiles(root, 'existing', ['existing']);

    await runProfileCreate('mcode-managed', {
      rootDir: root,
      agent: 'mcode',
      appId: 'cli_mcode_managed',
      appSecret: 'manual-secret',
      tenant: 'feishu',
    });

    const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as RootConfig;
    const managed = await realpath(
      resolveAppPaths({ rootDir: root, profile: 'mcode-managed' }).defaultWorkspaceDir,
    );
    expect(saved.profiles['mcode-managed']?.workspaces.default).toBe(managed);
  });
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-profile-create-'));
  roots.push(root);
  return root;
}

async function writeProfiles(root: string, activeProfile: string, names: string[]): Promise<void> {
  const profiles: RootConfig['profiles'] = {};
  for (const name of names) {
    profiles[name] = createDefaultProfileConfig({
      agentKind: 'mcode',
      accounts: {
        app: {
          id: `cli_${name.replace(/[^A-Za-z0-9]/g, '_')}`,
          secret: '${APP_SECRET}',
          tenant: 'feishu',
        },
      },
    });
    await mkdir(join(root, 'profiles', name), { recursive: true });
  }
  const config: RootConfig = {
    schemaVersion: 2,
    activeProfile,
    preferences: {},
    profiles,
  };
  await writeJson(join(root, 'config.json'), config);
  await writeFile(join(root, 'active-profile'), `${activeProfile}\n`, 'utf8');
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
