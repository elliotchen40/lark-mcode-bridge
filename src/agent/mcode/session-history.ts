import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { log } from '../../core/logger';
import { BRIDGE_USER_TURN_SEPARATOR } from '../bridge-system-prompt';

/**
 * Load `node:sqlite` at runtime through `createRequire` instead of a static
 * import.
 *
 * The module is a Node builtin (>=22.5), but bundler builtin lists lag it —
 * vite 5.4 for instance does not know `sqlite`, so a plain
 * `import ... from 'node:sqlite'` is rewritten into a bare `sqlite` specifier
 * and fails to resolve under vitest. Going through `createRequire` keeps the
 * specifier opaque to every bundler. Types still come from the static
 * type-only import above, which is erased at compile time.
 */
function loadDatabaseSync(): typeof import('node:sqlite').DatabaseSync {
  const require = createRequire(import.meta.url);
  return require('node:sqlite').DatabaseSync;
}

/**
 * One row of mcode's session history, as rendered by `/resume`.
 *
 * `title` in mcode's store is the first user message of the session, which is
 * exactly the "what was this about" signal a resume list needs — no separate
 * preview rendering required.
 */
export interface McodeSessionSummary {
  sessionId: string;
  preview: string;
  /** Last-activity time in epoch ms. */
  mtime: number;
}

export interface ListMcodeSessionsOptions {
  /** Override the data dir (tests / non-default installs). */
  dataDir?: string;
  /** Override the sqlite path outright. */
  databasePath?: string;
  /** Cap on returned rows, clamped to a sane range by the caller. */
  limit?: number;
}

const TABLE = 'local_runtime_sessions';
const MAX_PREVIEW_CHARS = 80;

/**
 * mcode's data directory.
 *
 * `MINIMAX_DATA_DIR` is what mcode itself honours, with `MAVIS_DATA_DIR` as the
 * older alias it also accepts; both default to `~/.minimax`. Read from the
 * bridge's own env so the two processes agree on where sessions live even when
 * the bridge runs as a system service with a different HOME.
 */
export function resolveMcodeDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.MINIMAX_DATA_DIR?.trim() || env.MAVIS_DATA_DIR?.trim();
  return explicit || join(homedir(), '.minimax');
}

export function resolveMcodeDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveMcodeDataDir(env), 'v2', 'sqlite', 'runtime-state.sqlite');
}

/**
 * List mcode sessions for one workspace, most recently used first.
 *
 * This reads mcode's internal sqlite store rather than a documented history
 * format, so it is deliberately defensive: a missing database, a renamed
 * table/column or a locked file degrades to an empty list (logged at warn)
 * instead of breaking `/resume`. Nothing here is a hard dependency of a run —
 * session continuity itself only needs the id returned by the previous run.
 */
export function listMcodeSessions(
  cwd: string,
  options: ListMcodeSessionsOptions = {},
): McodeSessionSummary[] {
  const databasePath = options.databasePath ?? resolveMcodeDatabasePath();
  if (!existsSync(databasePath)) return [];

  const limit = clampLimit(options.limit);
  let db: DatabaseSync | undefined;
  try {
    db = new (loadDatabaseSync())(databasePath, { readOnly: true });
    const rows = db
      .prepare(
        `SELECT session_id, title, updated_at_ms, created_at_ms
           FROM ${TABLE}
          WHERE workspace_dir = ? AND archived = 0
          ORDER BY updated_at_ms DESC
          LIMIT ?`,
      )
      .all(cwd, limit) as Array<{
      session_id?: unknown;
      title?: unknown;
      updated_at_ms?: unknown;
      created_at_ms?: unknown;
    }>;

    const entries: McodeSessionSummary[] = [];
    for (const row of rows) {
      const sessionId = typeof row.session_id === 'string' ? row.session_id : '';
      if (!sessionId) continue;
      const title = extractUserMessage(typeof row.title === 'string' ? row.title : '');
      const mtime =
        typeof row.updated_at_ms === 'number'
          ? row.updated_at_ms
          : typeof row.created_at_ms === 'number'
            ? row.created_at_ms
            : 0;
      entries.push({
        sessionId,
        preview: title ? truncatePreview(title) : '(无标题会话)',
        mtime,
      });
    }
    return entries;
  } catch (err) {
    log.warn('session', 'mcode-history-failed', {
      databasePath,
      message: (err as Error).message,
    });
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      // Closing a read-only handle can fail if the file vanished underneath.
    }
  }
}

/**
 * mcode records `workspace_dir` as it was resolved in its own process, which
 * can differ from the bridge's path by a symlink (notably `/tmp` ->
 * `/private/tmp` on macOS). Falls back to a realpath match when an exact
 * comparison finds nothing.
 */
export function listMcodeSessionsForCwd(
  cwd: string,
  options: ListMcodeSessionsOptions = {},
): McodeSessionSummary[] {
  const exact = listMcodeSessions(cwd, options);
  if (exact.length > 0) return exact;

  let resolved: string;
  try {
    resolved = realpathSync(cwd);
  } catch {
    return [];
  }
  if (resolved === cwd) return [];
  return listMcodeSessions(resolved, options);
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 5;
  return Math.min(20, Math.max(1, Math.floor(limit)));
}

/**
 * Reduce a stored session title to what the user actually asked.
 *
 * mcode titles a session with its first user message — and in this bridge that
 * first message is the whole system prompt plus the real question, which the
 * adapter prepends via {@link prefixBridgeSystemPrompt}. Without stripping it,
 * every `/resume` row would read as the same system-prompt header instead of
 * the user's question, because the header alone fills mcode's title budget.
 */
function extractUserMessage(title: string): string {
  const trimmed = title.trim();
  const separatorAt = trimmed.indexOf(BRIDGE_USER_TURN_SEPARATOR);
  if (separatorAt === -1) return trimmed;
  return trimmed.slice(separatorAt + BRIDGE_USER_TURN_SEPARATOR.length).trim();
}

function truncatePreview(title: string): string {
  const flat = title.replace(/\s+/g, ' ').trim();
  if (flat.length <= MAX_PREVIEW_CHARS) return flat;
  return `${flat.slice(0, MAX_PREVIEW_CHARS - 1)}…`;
}
