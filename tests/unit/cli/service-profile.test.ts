import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceAdapter } from '../../../src/daemon/service-adapter';
import type { ProcessEntry } from '../../../src/runtime/registry';

const mocks = vi.hoisted(() => ({
  adapter: undefined as unknown as ServiceAdapter,
  getServiceAdapter: vi.fn(),
  preFlightChecks: vi.fn(),
  materializeEnvSecretForService: vi.fn(),
  resolveProfileRuntime: vi.fn(),
  readAndPrune: vi.fn(),
  checkRuntimeLock: vi.fn(),
  stopProcessEntry: vi.fn(),
  readActiveProfile: vi.fn(),
  loadRootConfig: vi.fn(),
}));

vi.mock('../../../src/daemon/service-adapter', () => ({
  getServiceAdapter: mocks.getServiceAdapter,
}));

vi.mock('../../../src/runtime/profile-runtime', () => ({
  materializeEnvSecretForService: mocks.materializeEnvSecretForService,
  resolveProfileRuntime: mocks.resolveProfileRuntime,
}));

vi.mock('../../../src/runtime/registry', () => ({
  readAndPrune: mocks.readAndPrune,
}));

vi.mock('../../../src/runtime/locks', () => ({
  checkRuntimeLock: mocks.checkRuntimeLock,
}));

vi.mock('../../../src/cli/commands/ps', () => ({
  stopProcessEntry: mocks.stopProcessEntry,
}));

vi.mock('../../../src/config/profile-store', () => ({
  readActiveProfile: mocks.readActiveProfile,
  loadRootConfig: mocks.loadRootConfig,
}));

vi.mock('../../../src/config/paths', () => ({
  paths: {
    rootDir: '/tmp/lark-channel-home',
    configFile: '/tmp/lark-channel-home/config.json',
    profile: 'mcode',
  },
}));

vi.mock('../../../src/daemon/paths', () => ({
  daemonStdoutPath: (profile: string) => `/tmp/lark-channel-home/profiles/${profile}/logs/daemon/stdout.log`,
  daemonStderrPath: (profile: string) => `/tmp/lark-channel-home/profiles/${profile}/logs/daemon/stderr.log`,
  SUPERVISOR_SERVICE_ID: 'supervisor',
}));

vi.mock('../../../src/cli/preflight', () => ({
  preFlightChecks: mocks.preFlightChecks,
}));

const { runServiceStart, runServiceStatus, runServiceStop, runServiceUnregister } = await import('../../../src/cli/commands/service');

describe('profile-aware service commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adapter = {
      platformName: 'mock',
      fileExists: vi.fn(() => true),
      isRunning: vi.fn(() => false),
      servicePath: vi.fn(() => '/tmp/service'),
      install: vi.fn(async () => {}),
      start: vi.fn(() => ({ ok: true, stderr: '' })),
      stop: vi.fn(() => ({ ok: true, stderr: '' })),
      stopAndDisableAutostart: vi.fn(() => ({ ok: true, stderr: '' })),
      disableAutostart: vi.fn(() => ({ ok: true, stderr: '' })),
      restart: vi.fn(() => ({ ok: true, stderr: '' })),
      waitUntilStopped: vi.fn(async () => true),
      deleteFile: vi.fn(async () => {}),
      describeStatus: vi.fn(() => ''),
      parseStatus: vi.fn(() => ({})),
    };
    mocks.getServiceAdapter.mockReturnValue(mocks.adapter);
    mocks.materializeEnvSecretForService.mockResolvedValue(false);
    mocks.stopProcessEntry.mockResolvedValue('terminated');
    mocks.resolveProfileRuntime.mockResolvedValue({
      profile: 'mcode-dev',
      configPath: '/tmp/lark-channel-home/config.json',
      appPaths: {
        profile: 'mcode-dev',
        rootDir: '/tmp/lark-channel-home',
        larkCliConfigDir: '/tmp/lark-channel-home/profiles/mcode-dev/lark-cli',
        larkCliSourceConfigFile: '/tmp/lark-channel-home/profiles/mcode-dev/lark-cli-source/config.json',
        profileLockFile: '/tmp/lark-channel-home/registry/locks/profile/mcode-dev.lock',
        appLockFile: (appId: string) => `/tmp/lark-channel-home/registry/locks/app/${appId}.lock`,
      },
      cfg: {
        accounts: {
          app: {
            id: 'cli_mcode',
            secret: '${APP_SECRET}',
            tenant: 'feishu',
          },
        },
        agentKind: 'mcode',
      },
    });
    mocks.checkRuntimeLock.mockResolvedValue({ locked: false });
    mocks.readActiveProfile.mockResolvedValue('mcode-dev');
    mocks.loadRootConfig.mockResolvedValue({
      profiles: {
        'mcode-dev': {},
      },
    });
  });

  it('starts the OS service for the requested profile and reports the real agent', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line);
    });
    mocks.readAndPrune
      .mockReturnValueOnce([])
      .mockReturnValue([
        processEntry({
          id: 'p1',
          pid: 12345,
          appId: 'cli_mcode',
          profileName: 'mcode-dev',
          agentKind: 'mcode',
          botName: 'MiniMax Bot',
        }),
      ]);

    await runServiceStart({ profile: 'mcode-dev', skipCheckLarkCli: true });

    // Classic per-profile service pins `run --profile <profile>`.
    expect(mocks.getServiceAdapter).toHaveBeenCalledWith('mcode-dev', ['run', '--profile', 'mcode-dev']);
    expect(mocks.resolveProfileRuntime).toHaveBeenNthCalledWith(1, expect.objectContaining({
      profile: 'mcode-dev',
      agent: undefined,
      workspace: undefined,
      appId: undefined,
      appSecret: undefined,
      tenant: undefined,
      allowBootstrap: true,
      handleActiveBridgeMigrationConflict: expect.any(Function),
    }));
    expect(mocks.resolveProfileRuntime).toHaveBeenNthCalledWith(2, {
      profile: 'mcode-dev',
      allowBootstrap: false,
    });
    expect(mocks.materializeEnvSecretForService).toHaveBeenCalledWith({ profile: 'mcode-dev' });
    expect(mocks.preFlightChecks).toHaveBeenCalledWith({
      skipCheckLarkCli: true,
      bridgeConfig: expect.objectContaining({
        accounts: {
          app: {
            id: 'cli_mcode',
            secret: '${APP_SECRET}',
            tenant: 'feishu',
          },
        },
        agentKind: 'mcode',
      }),
      appPaths: expect.objectContaining({
        profile: 'mcode-dev',
        rootDir: '/tmp/lark-channel-home',
        larkCliConfigDir: '/tmp/lark-channel-home/profiles/mcode-dev/lark-cli',
        larkCliSourceConfigFile: '/tmp/lark-channel-home/profiles/mcode-dev/lark-cli-source/config.json',
      }),
      larkChannel: {
        profile: 'mcode-dev',
        rootDir: '/tmp/lark-channel-home',
        configPath: '/tmp/lark-channel-home/config.json',
        larkCliConfigDir: '/tmp/lark-channel-home/profiles/mcode-dev/lark-cli',
        larkCliSourceConfigFile: '/tmp/lark-channel-home/profiles/mcode-dev/lark-cli-source/config.json',
      },
    });
    expect(mocks.adapter.install).toHaveBeenCalled();
    expect(mocks.adapter.start).toHaveBeenCalled();
    expect(lines).toContain(
      '✓ 已启动  bot: MiniMax Bot (cli_mcode)  agent: MiniMax Code (mcode)  进程: p1',
    );
  });

  it('uses materialized config for service preflight after env secret materialization', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const materializedCfg = {
      accounts: {
        app: {
          id: 'cli_mcode',
          secret: {
            source: 'exec',
            provider: 'bridge',
            id: 'app-cli_mcode',
          },
          tenant: 'feishu',
        },
      },
      agentKind: 'mcode',
      secrets: {
        providers: {
          bridge: {
            source: 'exec',
            command: '/tmp/lark-channel-home/secrets-getter',
            args: [],
          },
        },
      },
    };
    mocks.materializeEnvSecretForService.mockResolvedValue(true);
    mocks.resolveProfileRuntime
      .mockResolvedValueOnce({
        profile: 'mcode-dev',
        configPath: '/tmp/lark-channel-home/config.json',
        appPaths: {
          profile: 'mcode-dev',
          rootDir: '/tmp/lark-channel-home',
          larkCliConfigDir: '/tmp/lark-channel-home/profiles/mcode-dev/lark-cli',
          larkCliSourceConfigFile: '/tmp/lark-channel-home/profiles/mcode-dev/lark-cli-source/config.json',
          profileLockFile: '/tmp/lark-channel-home/registry/locks/profile/mcode-dev.lock',
          appLockFile: (appId: string) => `/tmp/lark-channel-home/registry/locks/app/${appId}.lock`,
        },
        cfg: {
          accounts: {
            app: {
              id: 'cli_mcode',
              secret: '${APP_SECRET}',
              tenant: 'feishu',
            },
          },
          agentKind: 'mcode',
        },
      })
      .mockResolvedValueOnce({
        profile: 'mcode-dev',
        configPath: '/tmp/lark-channel-home/config.json',
        appPaths: {
          profile: 'mcode-dev',
          rootDir: '/tmp/lark-channel-home',
          larkCliConfigDir: '/tmp/lark-channel-home/profiles/mcode-dev/lark-cli',
          larkCliSourceConfigFile: '/tmp/lark-channel-home/profiles/mcode-dev/lark-cli-source/config.json',
          profileLockFile: '/tmp/lark-channel-home/registry/locks/profile/mcode-dev.lock',
          appLockFile: (appId: string) => `/tmp/lark-channel-home/registry/locks/app/${appId}.lock`,
        },
        cfg: materializedCfg,
      })
      .mockResolvedValueOnce({
        profile: 'mcode-dev',
        configPath: '/tmp/lark-channel-home/config.json',
        appPaths: {
          profile: 'mcode-dev',
          rootDir: '/tmp/lark-channel-home',
          larkCliConfigDir: '/tmp/lark-channel-home/profiles/mcode-dev/lark-cli',
          larkCliSourceConfigFile: '/tmp/lark-channel-home/profiles/mcode-dev/lark-cli-source/config.json',
          profileLockFile: '/tmp/lark-channel-home/registry/locks/profile/mcode-dev.lock',
          appLockFile: (appId: string) => `/tmp/lark-channel-home/registry/locks/app/${appId}.lock`,
        },
        cfg: materializedCfg,
      });
    mocks.readAndPrune
      .mockReturnValueOnce([])
      .mockReturnValue([
        processEntry({
          id: 'p1',
          pid: 12345,
          appId: 'cli_mcode',
          profileName: 'mcode-dev',
          agentKind: 'mcode',
          botName: 'MiniMax Bot',
        }),
      ]);

    await runServiceStart({ profile: 'mcode-dev', skipCheckLarkCli: false });

    expect(mocks.resolveProfileRuntime).toHaveBeenNthCalledWith(2, {
      profile: 'mcode-dev',
      allowBootstrap: false,
    });
    expect(mocks.preFlightChecks).toHaveBeenCalledWith(expect.objectContaining({
      bridgeConfig: materializedCfg,
    }));
    expect(mocks.preFlightChecks).not.toHaveBeenCalledWith(expect.objectContaining({
      bridgeConfig: expect.objectContaining({
        accounts: {
          app: {
            id: 'cli_mcode',
            secret: '${APP_SECRET}',
            tenant: 'feishu',
          },
        },
      }),
    }));
  });

  it('rejects start when the requested profile is already held by a foreground run', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line?: unknown) => {
      errors.push(String(line));
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    });
    mocks.checkRuntimeLock.mockResolvedValue({
      locked: true,
      meta: {
        kind: 'profile',
        target: '/tmp/lark-channel-home/registry/locks/profile/mcode-dev.lock',
        profile: 'mcode-dev',
        agentKind: 'mcode',
        pid: 2468,
        startedAt: '2026-05-26T10:50:33.082Z',
      },
    });
    mocks.readAndPrune
      .mockReturnValueOnce([])
      .mockReturnValue([
        processEntry({
          id: 'p1',
          pid: 12345,
          appId: 'cli_mcode',
          profileName: 'mcode-dev',
          agentKind: 'mcode',
          botName: 'MiniMax Bot',
        }),
      ]);

    await expect(runServiceStart({ profile: 'mcode-dev', skipCheckLarkCli: true })).rejects.toThrow(
      'exit:1',
    );

    expect(mocks.adapter.install).not.toHaveBeenCalled();
    expect(mocks.adapter.start).not.toHaveBeenCalled();
    expect(errors.join('\n')).toContain('当前 profile 已有 bridge 进程占用');
    expect(errors.join('\n')).toContain('pid=2468');

    exit.mockRestore();
  });

  it('stops a foreground lock holder and continues service start after interactive confirmation', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line);
    });
    const holder = {
      kind: 'profile' as const,
      target: '/tmp/lark-channel-home/registry/locks/profile/mcode-dev.lock',
      profile: 'mcode-dev',
      agentKind: 'mcode' as const,
      pid: 2468,
      startedAt: '2026-05-26T10:50:33.082Z',
    };
    mocks.checkRuntimeLock
      .mockResolvedValueOnce({ locked: true, meta: holder })
      .mockResolvedValueOnce({ locked: false })
      .mockResolvedValueOnce({ locked: false });
    mocks.readAndPrune
      .mockReturnValueOnce([])
      .mockReturnValue([
        processEntry({
          id: 'p1',
          pid: 12345,
          appId: 'cli_mcode',
          profileName: 'mcode-dev',
          agentKind: 'mcode',
          botName: 'MiniMax Bot',
        }),
      ]);

    await runServiceStart({
      profile: 'mcode-dev',
      skipCheckLarkCli: true,
      confirmStopRuntimeLockProcess: async () => true,
    });

    expect(mocks.stopProcessEntry).toHaveBeenCalledWith({ pid: 2468 });
    expect(mocks.adapter.install).toHaveBeenCalled();
    expect(mocks.adapter.start).toHaveBeenCalled();
    expect(lines).toContain('✓ 已停止 pid 2468');
  });

  it('rejects start when another profile already holds the same app lock', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line?: unknown) => {
      errors.push(String(line));
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    });
    mocks.checkRuntimeLock
      .mockResolvedValueOnce({ locked: false })
      .mockResolvedValueOnce({
        locked: true,
        meta: {
          kind: 'app',
          target: '/tmp/lark-channel-home/registry/locks/app/cli_mcode.lock',
          profile: 'mcode-dev',
          agentKind: 'mcode',
          appId: 'cli_mcode',
          pid: 2468,
          startedAt: '2026-05-26T10:50:33.085Z',
        },
      });

    await expect(runServiceStart({ profile: 'mcode-dev', skipCheckLarkCli: true })).rejects.toThrow(
      'exit:1',
    );

    expect(mocks.adapter.install).not.toHaveBeenCalled();
    expect(mocks.adapter.start).not.toHaveBeenCalled();
    expect(errors.join('\n')).toContain('当前 app 已有 bridge 进程占用');
    expect(errors.join('\n')).toContain('app=cli_mcode');

    exit.mockRestore();
  });

  it('lets start perform first-run bootstrap without requiring a profile concept', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mocks.resolveProfileRuntime.mockResolvedValue({
      profile: 'mcode',
      appPaths: {
        profileLockFile: '/tmp/lark-channel-home/registry/locks/profile/mcode.lock',
        appLockFile: (appId: string) => `/tmp/lark-channel-home/registry/locks/app/${appId}.lock`,
      },
      cfg: {
        accounts: {
          app: {
            id: 'cli_mcode',
            secret: '${APP_SECRET}',
            tenant: 'feishu',
          },
        },
        agentKind: 'mcode',
      },
    });
    mocks.readAndPrune
      .mockReturnValueOnce([])
      .mockReturnValue([
        processEntry({
          id: 'p2',
          pid: 12346,
          appId: 'cli_mcode',
          profileName: 'mcode',
          agentKind: 'mcode',
          botName: 'MiniMax Bot',
        }),
      ]);

    await runServiceStart({
      agent: 'mcode',
      workspace: '/repo',
      appId: 'cli_mcode',
      appSecret: 'manual-secret',
      tenant: 'feishu',
      skipCheckLarkCli: true,
    });

    expect(mocks.resolveProfileRuntime).toHaveBeenNthCalledWith(1, expect.objectContaining({
      profile: undefined,
      agent: 'mcode',
      workspace: '/repo',
      appId: 'cli_mcode',
      appSecret: 'manual-secret',
      tenant: 'feishu',
      allowBootstrap: true,
      handleActiveBridgeMigrationConflict: expect.any(Function),
    }));
    expect(mocks.resolveProfileRuntime).toHaveBeenNthCalledWith(2, {
      profile: 'mcode',
      allowBootstrap: false,
    });
    expect(mocks.getServiceAdapter).toHaveBeenCalledWith('mcode', ['run', '--profile', 'mcode']);
    expect(mocks.materializeEnvSecretForService).toHaveBeenCalledWith({ profile: 'mcode' });
    expect(mocks.adapter.install).toHaveBeenCalled();
    expect(mocks.adapter.start).toHaveBeenCalled();
  });

  it('uses the active profile when --profile is omitted and fails if none exists', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    (mocks.adapter.fileExists as ReturnType<typeof vi.fn>).mockReturnValue(false);

    await runServiceStatus();
    // Lifecycle commands (status/stop/restart/unregister) don't install, so
    // they pass no runArgs.
    expect(mocks.getServiceAdapter).toHaveBeenCalledWith('mcode-dev', undefined);

    mocks.readActiveProfile.mockResolvedValue(undefined);
    mocks.loadRootConfig.mockResolvedValue(undefined);
    await expect(runServiceStatus()).rejects.toThrow('active profile is required');
  });

  it('falls back to the supervisor service when the active profile has no service of its own', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line);
    });
    // Machine installed via `start --web-ui`: only the supervisor service
    // exists on disk, and it is the process hosting profile mcode-dev.
    const supervisor = { ...mocks.adapter, isRunning: vi.fn(() => true) } as ServiceAdapter;
    mocks.getServiceAdapter.mockImplementation((serviceId: string) =>
      serviceId === 'supervisor'
        ? supervisor
        : { ...mocks.adapter, fileExists: vi.fn(() => false) },
    );
    mocks.readAndPrune.mockReturnValue([]);

    await runServiceStop();

    // Must act on the supervisor service, not silently no-op on a
    // per-profile service that was never installed.
    expect(supervisor.stopAndDisableAutostart).toHaveBeenCalled();
    expect(lines.join('\n')).toContain('已指向控制面 supervisor 服务');
    expect(lines).toContain('✓ 控制面 supervisor 已停止运行');
  });

  it('turns off autostart when stopping a registered-but-not-running service', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line);
    });

    // fileExists=true, isRunning=false — nothing to kill, but the login-time
    // autostart is still armed and would bring the daemon back by itself.
    await runServiceStop({ profile: 'mcode-dev' });

    expect(mocks.adapter.disableAutostart).toHaveBeenCalled();
    expect(mocks.adapter.stopAndDisableAutostart).not.toHaveBeenCalled();
    expect(lines).toContain('  已关闭开机自启。');
  });

  it('leaves an explicit --profile target alone even when a supervisor service exists', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line);
    });
    const supervisor = { ...mocks.adapter, isRunning: vi.fn(() => true) } as ServiceAdapter;
    const classic = { ...mocks.adapter, fileExists: vi.fn(() => false) } as ServiceAdapter;
    mocks.getServiceAdapter.mockImplementation((serviceId: string) =>
      serviceId === 'supervisor' ? supervisor : classic,
    );

    await runServiceStop({ profile: 'mcode-dev' });

    expect(supervisor.stopAndDisableAutostart).not.toHaveBeenCalled();
    expect(classic.stopAndDisableAutostart).not.toHaveBeenCalled();
    expect(lines).toContain('bot 还没在后台运行过,无需停止。');
  });

  it('allows cleanup of an explicitly named service after its profile was removed', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line);
    });
    mocks.loadRootConfig.mockResolvedValue({
      profiles: {
        work: {},
      },
    });

    await runServiceStatus({ profile: 'mcode-dev' });
    await runServiceUnregister({ profile: 'mcode-dev' });

    expect(mocks.getServiceAdapter).toHaveBeenCalledWith('mcode-dev', undefined);
    expect(mocks.adapter.deleteFile).toHaveBeenCalled();
    expect(lines).toContain('✓ 已清除后台运行注册');
    expect(lines).toContain('  (配置 / 日志 / 会话保留在 /tmp/lark-channel-home)');
  });
});

function processEntry(overrides: Partial<ProcessEntry>): ProcessEntry {
  return {
    id: 'id',
    pid: process.pid,
    appId: 'cli_test',
    tenant: 'feishu',
    profileName: 'mcode',
    agentKind: 'mcode',
    configPath: '/tmp/config.json',
    startedAt: new Date().toISOString(),
    version: '0.1.32',
    ...overrides,
  };
}
