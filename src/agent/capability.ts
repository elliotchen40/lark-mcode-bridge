import type { AccessMode } from '../config/permissions';
import type { ProfileConfig } from '../config/profile-schema';
import { BRIDGE_SYSTEM_PROMPT } from './bridge-system-prompt';

export type AgentCapabilityId = 'mcode';
export type AgentSessionKind = 'mcode-session';
export type PromptInjectionMode = 'append-system-prompt' | 'stdin-prefix';

export interface AgentCapability {
  agentId: AgentCapabilityId;
  sessionKind: AgentSessionKind;
  promptInjection: PromptInjectionMode;
  systemPrompt: string;
  supportsNativeHistory: boolean;
  callback: {
    marker: '__bridge_cb';
    legacyMarkers: string[];
  };
  permissions: {
    maxAccess: AccessMode;
  };
}

/**
 * `mcode exec` has no `--append-system-prompt-file`, so the bridge contract is
 * prepended to the user turn on stdin — hence `stdin-prefix`.
 *
 * `supportsNativeHistory` is false because mcode persists sessions in its own
 * sqlite store rather than a documented, stable on-disk history format; the
 * bridge reads it defensively for `/resume` instead of treating it as a
 * guaranteed interface.
 */
export function mcodeCapability(profile?: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  const maxAccess = profile?.permissions.maxAccess ?? 'full';
  return {
    agentId: 'mcode',
    sessionKind: 'mcode-session',
    promptInjection: 'stdin-prefix',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: false,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: [],
    },
    permissions: {
      maxAccess,
    },
  };
}
