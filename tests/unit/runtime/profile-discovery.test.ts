import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDefaultProfileConfig,
  type RootConfig,
} from '../../../src/config/profile-schema';
import { listAllProfiles } from '../../../src/runtime/profile-discovery';

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-profile-discovery-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('listAllProfiles', () => {
  it('lists profiles from root config with active profile first and others sorted', async () => {
    const root = await makeRoot();
    await writeRootConfig(root, {
      activeProfile: 'work',
      profiles: {
        zeta: profile('cli_zeta'),
        work: profile('cli_work'),
        'mcode-dev': profile('cli_dev'),
      },
    });
    await writeFile(join(root, 'active-profile'), 'mcode-dev\n', 'utf8');
    await mkdir(join(root, 'profiles', 'work'), { recursive: true });
    await mkdir(join(root, 'profiles', 'mcode-dev'), { recursive: true });
    await mkdir(join(root, 'profiles', 'zeta'), { recursive: true });

    const profiles = await listAllProfiles(root);

    expect(profiles.map((item) => item.name)).toEqual(['mcode-dev', 'work', 'zeta']);
    expect(profiles.map((item) => item.active)).toEqual([true, false, false]);
    expect(profiles[0]).toMatchObject({
      agentKind: 'mcode',
      profileDir: join(root, 'profiles', 'mcode-dev'),
    });
  });

  it('fails when active-profile points at a missing profile', async () => {
    const root = await makeRoot();
    await writeRootConfig(root, {
      activeProfile: 'work',
      profiles: {
        work: profile('cli_work'),
      },
    });
    await writeFile(join(root, 'active-profile'), 'missing\n', 'utf8');
    await mkdir(join(root, 'profiles', 'work'), { recursive: true });

    await expect(listAllProfiles(root)).rejects.toThrow('active profile not found: missing');
  });

  it('fails when config profiles are missing state directories', async () => {
    const root = await makeRoot();
    await writeRootConfig(root, {
      activeProfile: 'work',
      profiles: {
        work: profile('cli_work'),
        'mcode-dev': profile('cli_dev'),
      },
    });
    await mkdir(join(root, 'profiles', 'work'), { recursive: true });

    await expect(listAllProfiles(root)).rejects.toThrow('profile state directory missing: mcode-dev');
  });

  it('fails when a state directory has no matching config profile', async () => {
    const root = await makeRoot();
    await writeRootConfig(root, {
      activeProfile: 'work',
      profiles: {
        work: profile('cli_work'),
      },
    });
    await mkdir(join(root, 'profiles', 'work'), { recursive: true });
    await mkdir(join(root, 'profiles', 'orphan'), { recursive: true });

    await expect(listAllProfiles(root)).rejects.toThrow(
      'profile state directory without config: orphan',
    );
  });

  it('ignores a log-only orphan profile directory left by early startup logging', async () => {
    const root = await makeRoot();
    await writeRootConfig(root, {
      activeProfile: 'mcode-dev',
      profiles: {
        'mcode-dev': profile('cli_dev'),
      },
    });
    await mkdir(join(root, 'profiles', 'mcode-dev'), { recursive: true });
    await mkdir(join(root, 'profiles', 'work', 'logs'), { recursive: true });
    await writeFile(
      join(root, 'profiles', 'work', 'logs', 'bridge-20260526.jsonl'),
      '{}\n',
      'utf8',
    );

    await expect(listAllProfiles(root)).resolves.toMatchObject([
      { name: 'mcode-dev', active: true },
    ]);
  });
});

function profile(appId: string) {
  return createDefaultProfileConfig({
    agentKind: 'mcode',
    accounts: {
      app: {
        id: appId,
        secret: '${APP_SECRET}',
        tenant: 'feishu',
      },
    },
    mcode: { binaryPath: '/usr/local/bin/mcode' },
  });
}

async function writeRootConfig(
  root: string,
  overrides: Pick<RootConfig, 'activeProfile' | 'profiles'>,
): Promise<void> {
  const config: RootConfig = {
    schemaVersion: 2,
    preferences: {},
    ...overrides,
  };
  await writeFile(join(root, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}
