import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentPreflightError } from '../agent/preflight';
import { createDefaultProfileConfig, type AgentKind, type ProfileConfig } from '../config/profile-schema';
import type { AppConfig } from '../config/schema';
import { resolveWorkingDirectory } from '../policy/workspace';
import { resolveExecutablePath } from './agent-detection';

export interface BootstrapProfileInput {
  agentKind: AgentKind;
  accounts: AppConfig['accounts'];
  preferences?: AppConfig['preferences'];
  secrets?: AppConfig['secrets'];
  workspace?: string;
  defaultWorkspace?: string;
  mcodeBinaryPath?: string;
  profileDir?: string;
}

export async function createBootstrapProfileConfig(
  input: BootstrapProfileInput,
): Promise<ProfileConfig> {
  const workspace = input.workspace
    ? await resolveBootstrapWorkspace(input.workspace)
    : input.defaultWorkspace
      ? await ensureManagedDefaultWorkspace(input.defaultWorkspace)
      : undefined;
  // Pin the resolved `mcode` path at bootstrap so a later run cannot silently
  // pick up a different binary than the one this profile was created against.
  const mcode = await createBootstrapMcodeConfig(input.mcodeBinaryPath);
  const profile = createDefaultProfileConfig({
    agentKind: input.agentKind,
    accounts: input.accounts,
    preferences: input.preferences,
    secrets: input.secrets,
    mcode,
  });
  if (workspace) {
    profile.workspaces = {
      ...profile.workspaces,
      default: workspace,
    };
  }
  return profile;
}

export async function resolveBootstrapWorkspace(workspace: string): Promise<string> {
  const resolved = await resolveWorkingDirectory(workspace);
  if (!resolved.ok) throw new Error(resolved.userVisible);
  return resolved.cwdRealpath;
}

async function ensureManagedDefaultWorkspace(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  return realpath(path);
}

export async function createBootstrapMcodeConfig(binaryPath: string | undefined) {
  const command = binaryPath ?? process.env.LARK_CHANNEL_MCODE_BIN ?? 'mcode';
  let resolvedBinary: string;
  try {
    resolvedBinary = await resolveExecutablePath(command);
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code;
    throw new AgentPreflightError({
      code: mcodeBootstrapBinaryErrorCode(errno),
      agentId: 'mcode',
      agentName: 'MiniMax Code',
      command,
      binaryPath: command,
      errno,
    });
  }
  return { binaryPath: resolvedBinary };
}

function mcodeBootstrapBinaryErrorCode(errno: string | undefined) {
  if (errno === 'EACCES' || errno === 'EPERM') return 'agent-binary-not-executable';
  if (errno === 'ELOOP' || errno === 'ENOTDIR' || errno === 'EINVAL') {
    return 'agent-binary-resolve-failed';
  }
  return 'agent-binary-not-found';
}
