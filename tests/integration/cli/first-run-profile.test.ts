import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectInstalledAgents, resolveExecutablePath } from '../../../src/cli/agent-detection';
import { createBootstrapProfileConfig } from '../../../src/cli/profile-bootstrap';
import { writeVersionExecutable } from '../../helpers/fake-executable';

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-first-run-profile-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('first-run profile bootstrap', () => {
  it('creates an mcode profile with a default workspace and a pinned binary path', async () => {
    const root = await makeRoot();
    const workspace = join(root, 'workspace');
    const profileDir = join(root, 'profiles', 'mcode-dev');
    await mkdir(workspace, { recursive: true });
    const mcode = await writeVersionExecutable(root, 'mcode', 'mcode 1.2.3');

    const profile = await createBootstrapProfileConfig({
      agentKind: 'mcode',
      accounts: { app: { id: 'cli_mcode', secret: '${APP_SECRET}', tenant: 'feishu' } },
      workspace,
      mcodeBinaryPath: mcode,
      profileDir,
    });

    const workspaceRealpath = await realpath(workspace);
    expect(profile.agentKind).toBe('mcode');
    expect(profile.workspaces).toEqual({ default: workspaceRealpath });
    expect(profile.mcode).toEqual({ binaryPath: mcode });
    expect(profile).not.toHaveProperty('sandbox');
    expect(profile).not.toHaveProperty('codex');
    expect(profile.permissions).toEqual({ defaultAccess: 'full', maxAccess: 'full' });
  });

  it('creates a profile without requiring a user workspace', async () => {
    const root = await makeRoot();
    const defaultWorkspace = join(root, 'managed-workspaces', 'mcode-dev', 'default');
    const profileDir = join(root, 'profiles', 'mcode-dev');
    const mcode = await writeVersionExecutable(root, 'mcode', 'mcode 1.2.3');

    const profile = await createBootstrapProfileConfig({
      agentKind: 'mcode',
      accounts: { app: { id: 'cli_mcode', secret: '${APP_SECRET}', tenant: 'feishu' } },
      mcodeBinaryPath: mcode,
      profileDir,
      defaultWorkspace,
    });

    const defaultWorkspaceRealpath = await realpath(defaultWorkspace);
    expect(profile.workspaces.default).toBe(defaultWorkspaceRealpath);
  });

  it('reports a missing mcode bootstrap binary as an agent preflight diagnostic', async () => {
    const root = await makeRoot();
    const missing = join(root, 'missing-mcode');

    await expect(
      createBootstrapProfileConfig({
        agentKind: 'mcode',
        accounts: { app: { id: 'cli_mcode', secret: '${APP_SECRET}', tenant: 'feishu' } },
        mcodeBinaryPath: missing,
      }),
    ).rejects.toMatchObject({
      diagnostic: {
        code: 'agent-binary-not-found',
        agentId: 'mcode',
        agentName: 'MiniMax Code',
        command: missing,
        binaryPath: missing,
      },
    });
  });

  it('fails closed when a requested bootstrap workspace is not a directory', async () => {
    const root = await makeRoot();
    const file = join(root, 'not-a-dir');
    await writeFile(file, 'x', 'utf8');

    await expect(
      createBootstrapProfileConfig({
        agentKind: 'mcode',
        accounts: { app: { id: 'cli_mcode', secret: '${APP_SECRET}', tenant: 'feishu' } },
        workspace: file,
      }),
    ).rejects.toThrow(/路径不是目录/);
  });

  it('accepts a requested bootstrap workspace without requiring git', async () => {
    const root = await makeRoot();
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const mcode = await writeVersionExecutable(root, 'mcode', 'mcode 1.2.3');

    const profile = await createBootstrapProfileConfig({
      agentKind: 'mcode',
      accounts: { app: { id: 'cli_mcode', secret: '${APP_SECRET}', tenant: 'feishu' } },
      workspace,
      mcodeBinaryPath: mcode,
    });

    await expect(realpath(workspace)).resolves.toBe(profile.workspaces.default);
  });

  it('leaves workspaces empty when neither explicit nor managed workspace is provided', async () => {
    const root = await makeRoot();
    const mcode = await writeVersionExecutable(root, 'mcode', 'mcode 1.2.3');

    await expect(
      createBootstrapProfileConfig({
        agentKind: 'mcode',
        accounts: { app: { id: 'cli_mcode', secret: '${APP_SECRET}', tenant: 'feishu' } },
        mcodeBinaryPath: mcode,
      }),
    ).resolves.toMatchObject({
      workspaces: {},
    });
  });

  it('detects the mcode binary from PATH without inventing missing tools', async () => {
    const root = await makeRoot();
    const mcode = await writeVersionExecutable(root, 'mcode', 'mcode 1.2.3');
    const oldPath = process.env.PATH;
    const oldMcodeBin = process.env.LARK_CHANNEL_MCODE_BIN;
    process.env.PATH = root;
    process.env.LARK_CHANNEL_MCODE_BIN = process.platform === 'win32' ? mcode : 'mcode';
    try {
      await expect(detectInstalledAgents()).resolves.toEqual([
        { kind: 'mcode', binaryPath: mcode },
      ]);
    } finally {
      process.env.PATH = oldPath;
      if (oldMcodeBin === undefined) {
        delete process.env.LARK_CHANNEL_MCODE_BIN;
      } else {
        process.env.LARK_CHANNEL_MCODE_BIN = oldMcodeBin;
      }
    }
  });

  it('reports no installed agent when the mcode binary is missing', async () => {
    const root = await makeRoot();
    const oldPath = process.env.PATH;
    const oldMcodeBin = process.env.LARK_CHANNEL_MCODE_BIN;
    process.env.PATH = root;
    process.env.LARK_CHANNEL_MCODE_BIN = 'mcode';
    try {
      await expect(detectInstalledAgents()).resolves.toEqual([]);
    } finally {
      process.env.PATH = oldPath;
      if (oldMcodeBin === undefined) {
        delete process.env.LARK_CHANNEL_MCODE_BIN;
      } else {
        process.env.LARK_CHANNEL_MCODE_BIN = oldMcodeBin;
      }
    }
  });

  it('resolves Windows-style PATHEXT command shims from PATH', async () => {
    const root = await makeRoot();
    await writeExecutable(root, 'mcode.cmd', '@echo off\r\necho mcode 1.2.3\r\n');
    const oldPath = process.env.PATH;
    const oldPathExt = process.env.PATHEXT;
    process.env.PATH = root;
    process.env.PATHEXT = '.cmd;.exe';
    try {
      await expect(resolveExecutablePath('mcode')).resolves.toBe(join(root, 'mcode.cmd'));
    } finally {
      process.env.PATH = oldPath;
      if (oldPathExt === undefined) {
        delete process.env.PATHEXT;
      } else {
        process.env.PATHEXT = oldPathExt;
      }
    }
  });
});

async function writeExecutable(root: string, name: string, content: string): Promise<string> {
  const file = join(root, name);
  await writeFile(file, content, { mode: 0o755 });
  return file;
}
