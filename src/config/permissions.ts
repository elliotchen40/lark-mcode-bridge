/**
 * Access ladder for a single agent run.
 *
 * This is the canonical, agent-agnostic vocabulary: `/config` edits these
 * three levels, the run policy clamps a profile's request against the agent
 * capability, and only the final step translates into the flag `mcode exec`
 * actually understands.
 */
export type AccessMode = 'read-only' | 'workspace' | 'full';

/**
 * mcode's tool-execution policy, forwarded to `mcode exec --permission`.
 *
 * There is deliberately no `ask` option: mcode only offers interactive
 * approval in the TUI / ACP transports, and the bridge drives the headless
 * `exec` transport, where an approval request would hang the run.
 */
export type McodePermissionPolicy = 'off' | 'smart' | 'full';

export interface PermissionConfig {
  defaultAccess: AccessMode;
  maxAccess: AccessMode;
  mcode?: {
    policy?: McodePermissionPolicy;
  };
}

export type PermissionSource = 'permissions' | 'default';

export interface NormalizedPermissions {
  permissions: PermissionConfig;
  source: PermissionSource;
}

const ACCESS_ORDER: Record<AccessMode, number> = {
  'read-only': 0,
  workspace: 1,
  full: 2,
};

/**
 * Capability each mcode policy represents, used to keep an explicit override
 * from silently exceeding the profile's `maxAccess`.
 */
const MCODE_POLICY_ACCESS: Record<McodePermissionPolicy, AccessMode> = {
  off: 'read-only',
  smart: 'workspace',
  full: 'full',
};

export function normalizePermissions(input: {
  permissions?: Partial<PermissionConfig> | undefined;
}): NormalizedPermissions {
  if (input.permissions === undefined) {
    return { permissions: defaultPermissions(), source: 'default' };
  }
  return {
    permissions: normalizeCanonicalPermissions(input.permissions, defaultPermissions()),
    source: 'permissions',
  };
}

export function assertAccessPair(
  defaultAccess: AccessMode,
  maxAccess: AccessMode,
  source: PermissionSource = 'permissions',
): void {
  if (ACCESS_ORDER[defaultAccess] > ACCESS_ORDER[maxAccess]) {
    const suffix = source === 'default' ? '' : ` from ${source}`;
    throw new Error(`permission defaultAccess cannot exceed maxAccess${suffix}`);
  }
}

export function clampAccess(
  defaultAccess: AccessMode,
  profileMax: AccessMode,
  capabilityMax: AccessMode,
): AccessMode {
  const maxAllowed =
    ACCESS_ORDER[profileMax] < ACCESS_ORDER[capabilityMax] ? profileMax : capabilityMax;
  return ACCESS_ORDER[defaultAccess] <= ACCESS_ORDER[maxAllowed] ? defaultAccess : maxAllowed;
}

/**
 * Resolve the policy handed to `mcode exec --permission`.
 *
 * An explicit `permissions.mcode.policy` wins when it does not exceed the
 * already-clamped `access` level; otherwise the level maps directly. This is
 * what keeps `/config` from being able to grant more than the profile allows.
 */
export function accessToMcodePolicy(
  access: AccessMode,
  permissions?: PermissionConfig,
): McodePermissionPolicy {
  const override = permissions?.mcode?.policy;
  if (
    override &&
    ACCESS_ORDER[MCODE_POLICY_ACCESS[override]] <= ACCESS_ORDER[access]
  ) {
    return override;
  }
  return accessToDefaultMcodePolicy(access);
}

function accessToDefaultMcodePolicy(access: AccessMode): McodePermissionPolicy {
  switch (access) {
    case 'read-only':
      return 'off';
    case 'workspace':
      return 'smart';
    case 'full':
      return 'full';
  }
}

/** The access level a stored mcode policy represents (for display / clamping). */
export function mcodePolicyToAccess(policy: McodePermissionPolicy): AccessMode {
  return MCODE_POLICY_ACCESS[policy];
}

function normalizeCanonicalPermissions(
  input: Partial<PermissionConfig>,
  base: PermissionConfig,
): PermissionConfig {
  if (!isConfigObject(input)) {
    throw new Error('invalid permission config');
  }

  const explicitMaxAccess = readAccess(input.maxAccess, 'maxAccess');
  const explicitDefaultAccess = readAccess(input.defaultAccess, 'defaultAccess');
  const maxAccess = explicitMaxAccess ?? base.maxAccess;
  const defaultAccess =
    explicitDefaultAccess ??
    (ACCESS_ORDER[base.defaultAccess] <= ACCESS_ORDER[maxAccess] ? base.defaultAccess : maxAccess);
  assertAccessPair(defaultAccess, maxAccess);

  const mcode = normalizeMcodePermissions(input.mcode);
  if (mcode?.policy) {
    assertMcodePolicyWithinAccess(mcode.policy, maxAccess);
  }
  return {
    defaultAccess,
    maxAccess,
    ...(mcode ? { mcode } : {}),
  };
}

function defaultPermissions(): PermissionConfig {
  return {
    defaultAccess: 'full',
    maxAccess: 'full',
  };
}

function assertMcodePolicyWithinAccess(
  policy: McodePermissionPolicy,
  maxAccess: AccessMode,
): void {
  if (ACCESS_ORDER[MCODE_POLICY_ACCESS[policy]] > ACCESS_ORDER[maxAccess]) {
    throw new Error('permission mcode.policy cannot exceed maxAccess');
  }
}

function normalizeMcodePermissions(
  input: PermissionConfig['mcode'] | undefined,
): PermissionConfig['mcode'] | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (!isConfigObject(input)) {
    throw new Error('invalid permission mcode config');
  }
  if (input.policy === undefined) {
    return undefined;
  }
  if (!isMcodePermissionPolicy(input.policy)) {
    throw new Error('invalid permission mcode.policy');
  }
  return {
    policy: input.policy,
  };
}

function readAccess(value: unknown, field: string): AccessMode | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isAccessMode(value)) {
    throw new Error(`invalid permission ${field}`);
  }
  return value;
}

function isAccessMode(value: unknown): value is AccessMode {
  return value === 'read-only' || value === 'workspace' || value === 'full';
}

function isConfigObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isMcodePermissionPolicy(value: unknown): value is McodePermissionPolicy {
  return value === 'off' || value === 'smart' || value === 'full';
}
