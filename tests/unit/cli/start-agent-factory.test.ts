import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertReconnectAgentKindUnchanged,
  createRuntimeAgent,
} from '../../../src/cli/commands/start.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { createRuntimeProfileConfig } from '../../../src/runtime/profile-runtime.js';

describe('start runtime agent factory', () => {
  it('keeps mcode as the only runtime agent', () => {
    const agent = createRuntimeAgent(
      createDefaultProfileConfig({
        agentKind: 'mcode',
        accounts: appAccount(),
      }),
      { profileDir: tmpdir() },
    );

    expect(agent.id).toBe('mcode');
    expect(agent.displayName).toBe('MiniMax Code');
  });

  it('creates the mcode runtime agent from canonical workspace permissions', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'mcode',
      accounts: appAccount(),
      mcode: mcodeConfig(),
      permissions: { defaultAccess: 'workspace', maxAccess: 'workspace' },
    });
    const agent = createRuntimeAgent(profile, {
      profileDir: '/tmp/lark-channel-bridge/profiles/mcode-e2e',
    });

    expect(agent.id).toBe('mcode');
    expect(agent.displayName).toBe('MiniMax Code');
    expect(profile.permissions).toEqual({
      defaultAccess: 'workspace',
      maxAccess: 'workspace',
    });
  });

  it('creates a mcode runtime agent when a profile pins only a binary path', () => {
    const agent = createRuntimeAgent(
      createDefaultProfileConfig({
        agentKind: 'mcode',
        accounts: appAccount(),
        mcode: { binaryPath: '/usr/local/bin/mcode' },
      }),
      { profileDir: '/tmp/lark-channel-bridge/profiles/mcode-e2e' },
    );

    expect(agent.id).toBe('mcode');
    expect(agent.displayName).toBe('MiniMax Code');
  });

  it('does not pin an mcode binary when bootstrapping a profile config', () => {
    const profile = createRuntimeProfileConfig({
      agentKind: 'mcode',
      accounts: appAccount(),
    });

    // Resolution from PATH happens in the bootstrap/preflight flow, not in
    // the default profile config.
    expect(profile.mcode).toBeUndefined();
  });

  it('updates the process registry before releasing the old app lock during reconnect', async () => {
    // Reconnect ordering now lives in the supervisor's ManagedProfile.restart().
    const source = await readFile(join(process.cwd(), 'src/runtime/supervisor.ts'), 'utf8');
    const restartStart = source.indexOf('async restart()');
    const updateIndex = source.indexOf('updateEntry(', restartStart);
    const releaseIndex = source.indexOf('oldAppLock?.release()', restartStart);

    expect(restartStart).toBeGreaterThanOrEqual(0);
    expect(updateIndex).toBeGreaterThanOrEqual(0);
    expect(releaseIndex).toBeGreaterThanOrEqual(0);
    expect(updateIndex).toBeLessThan(releaseIndex);
  });

  it('shuts down the supervisor (releasing profile locks) before exiting', async () => {
    // Graceful shutdown: the supervisor stops all channels (releasing each
    // profile's locks) before the process exits.
    const source = await readFile(join(process.cwd(), 'src/cli/commands/start.ts'), 'utf8');
    const stopStart = source.indexOf('const shutdown = async');
    const shutdownIndex = source.indexOf('await supervisor.shutdown()', stopStart);
    const exitIndex = source.indexOf('process.exit(0)', stopStart);

    expect(stopStart).toBeGreaterThanOrEqual(0);
    expect(shutdownIndex).toBeGreaterThanOrEqual(0);
    expect(exitIndex).toBeGreaterThanOrEqual(0);
    expect(shutdownIndex).toBeLessThan(exitIndex);

    // And each channel's teardown releases its runtime locks.
    const sup = await readFile(join(process.cwd(), 'src/runtime/supervisor.ts'), 'utf8');
    expect(sup).toContain('releaseRuntimeLocks(this.locks)');
  });

  it('allows reconnect when a profile keeps the same agent kind', () => {
    expect(() => assertReconnectAgentKindUnchanged('mcode', 'mcode')).not.toThrow();
    expect(() => assertReconnectAgentKindUnchanged(undefined, 'mcode')).not.toThrow();
    expect(() => assertReconnectAgentKindUnchanged(undefined, undefined)).not.toThrow();
  });
});

function appAccount() {
  return {
    app: {
      id: 'cli_xxx',
      secret: '${APP_SECRET}',
      tenant: 'feishu' as const,
    },
  };
}

function mcodeConfig() {
  return {
    binaryPath: '/usr/local/bin/mcode',
  };
}
