import type { McodePermissionPolicy } from '../../config/permissions';

/**
 * Input for {@link buildMcodeArgs}.
 *
 * Everything the bridge controls about a single agent invocation lives here so
 * the argv shape stays unit-testable without spawning a process.
 */
export interface BuildMcodeArgsInput {
  /** Workspace the run is pinned to. Always passed explicitly. */
  cwd: string;
  /** Tool-execution policy, forwarded to `mcode exec --permission`. */
  permission: McodePermissionPolicy;
  /** Existing mcode session to continue (`--session`). */
  sessionId?: string;
  /** Local file paths (images / documents) to attach to the turn. */
  files?: readonly string[];
  /** `provider/model` id, forwarded to `--model`. Omit to use the account default. */
  model?: string;
  /** Reasoning effort, forwarded to `--effort`. */
  effort?: string;
  /** Upper bound on assistant steps for this run. Omit for no explicit cap. */
  maxSteps?: number;
}

/**
 * Build the argv for a single `mcode exec` run.
 *
 * The prompt is NOT part of argv — it is fed through stdin via `--input -`.
 * Two reasons:
 *
 *  1. Windows shims. `mcode` resolves to a `.cmd` shim on Windows, and
 *     cross-spawn routes those through `cmd.exe /d /s /c`, which treats `<`
 *     and `>` as redirection operators. The bridge's system prompt and user
 *     prompt are full of XML-ish tags (`<bridge_context>`, `<quoted_message>`),
 *     so passing them via argv silently truncates the request.
 *  2. Size. Long chat transcripts and attachment prompts can exceed the
 *     Windows command-line limit entirely.
 *
 * `--input -` with the default `--input-format text` reads the prompt from
 * stdin, so no shell ever sees it.
 */
export function buildMcodeArgs(input: BuildMcodeArgsInput): string[] {
  const permission = assertPermissionPolicy(input.permission);

  const args = [
    'exec',
    '--output-format',
    'stream-json',
    '--permission',
    permission,
    '--cwd',
    assertCwd(input.cwd),
  ];

  if (input.sessionId) args.push('--session', input.sessionId);
  if (input.model) args.push('--model', input.model);
  if (input.effort) args.push('--effort', input.effort);
  if (input.maxSteps !== undefined) args.push('--max-steps', String(input.maxSteps));

  // `--file` is repeatable and carries images as well as documents.
  for (const file of input.files ?? []) {
    args.push('--file', file);
  }

  // Read the prompt from stdin. Must come last so a stray positional can
  // never be reinterpreted as the `review` subcommand.
  args.push('--input', '-');

  return args;
}

export function assertPermissionPolicy(value: unknown): McodePermissionPolicy {
  if (value !== 'off' && value !== 'smart' && value !== 'full') {
    throw new Error(`invalid mcode permission policy: ${String(value)}`);
  }
  return value;
}

function assertCwd(cwd: string): string {
  if (!cwd || !cwd.trim()) {
    throw new Error('cwd is required for mcode exec');
  }
  return cwd;
}
