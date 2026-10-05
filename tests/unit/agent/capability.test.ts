import { describe, expect, it } from 'vitest';
import { BRIDGE_SYSTEM_PROMPT } from '../../../src/agent/bridge-system-prompt';
import { mcodeCapability } from '../../../src/agent/capability';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';

describe('agent capability contract', () => {
  it('defines the mcode capability with stdin prompt injection and no legacy markers', () => {
    const capability = mcodeCapability();

    expect(capability).toMatchObject({
      agentId: 'mcode',
      sessionKind: 'mcode-session',
      promptInjection: 'stdin-prefix',
      supportsNativeHistory: false,
      systemPrompt: BRIDGE_SYSTEM_PROMPT,
      callback: {
        marker: '__bridge_cb',
        legacyMarkers: [],
      },
      permissions: {
        maxAccess: 'full',
      },
    });
  });

  it('defines the mcode capability with a profile-scoped access ceiling', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'mcode',
      accounts: {
        app: {
          id: 'cli_test',
          secret: '${APP_SECRET}',
          tenant: 'feishu',
        },
      },
      mcode: {
        binaryPath: '/usr/local/bin/mcode',
      },
      permissions: {
        defaultAccess: 'workspace',
        maxAccess: 'workspace',
      },
    });

    expect(mcodeCapability(profile)).toMatchObject({
      agentId: 'mcode',
      sessionKind: 'mcode-session',
      promptInjection: 'stdin-prefix',
      supportsNativeHistory: false,
      systemPrompt: BRIDGE_SYSTEM_PROMPT,
      permissions: {
        maxAccess: 'workspace',
      },
    });
  });

  it('uses the mcode profile max access as the static capability ceiling', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'mcode',
      accounts: {
        app: {
          id: 'cli_test',
          secret: '${APP_SECRET}',
          tenant: 'feishu',
        },
      },
      mcode: {
        binaryPath: '/usr/local/bin/mcode',
      },
      permissions: {
        defaultAccess: 'read-only',
        maxAccess: 'read-only',
      },
    });

    expect(mcodeCapability(profile).permissions.maxAccess).toBe('read-only');
  });
});
