import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// `node:sqlite` is a Node builtin that bundler builtin lists (vite 5.4) do not
// know about, so it is loaded via createRequire here for the same reason the
// source module does it. See src/agent/mcode/session-history.ts.
const DatabaseSyncCtor = createRequire(import.meta.url)('node:sqlite')
  .DatabaseSync as typeof import('node:sqlite').DatabaseSync;
import { BRIDGE_SYSTEM_PROMPT } from '../../../src/agent/bridge-system-prompt';
import {
  listMcodeSessions,
  listMcodeSessionsForCwd,
  resolveMcodeDataDir,
  resolveMcodeDatabasePath,
} from '../../../src/agent/mcode/session-history';

const TABLE = 'local_runtime_sessions';

/** Assert-exactly-one helper: the list lookups below must return a single row. */
function first(entries: Array<{ sessionId: string; preview: string; mtime: number }>) {
  expect(entries).toHaveLength(1);
  return entries[0]!;
}

interface RowInput {
  sessionId: string;
  title?: string | null;
  createdAtMs?: number;
  updatedAtMs?: number;
  workspaceDir?: string;
  archived?: number;
}

describe('mcode session history', () => {
  let root: string;
  let dbPath: string;
  let db: DatabaseSync;

  function insert(row: RowInput): void {
    db.prepare(
      `INSERT INTO ${TABLE}
         (session_id, title, created_at_ms, updated_at_ms, workspace_dir, status, archived)
       VALUES (?, ?, ?, ?, ?, 'idle', ?)`,
    ).run(
      row.sessionId,
      row.title ?? null,
      row.createdAtMs ?? 1_000,
      row.updatedAtMs ?? 2_000,
      row.workspaceDir ?? '/work',
      row.archived ?? 0,
    );
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mcode-history-'));
    dbPath = join(root, 'runtime-state.sqlite');
    db = new DatabaseSyncCtor(dbPath);
    db.exec(`CREATE TABLE ${TABLE} (
      session_id TEXT PRIMARY KEY,
      title TEXT,
      created_at_ms INTEGER,
      updated_at_ms INTEGER,
      workspace_dir TEXT,
      agent_name TEXT,
      status TEXT,
      archived INTEGER,
      session_type TEXT,
      record_json TEXT
    )`);
  });

  afterEach(async () => {
    try {
      db.close();
    } catch {
      // already closed
    }
    await rm(root, { recursive: true, force: true });
  });

  it('lists sessions for one workspace, newest first', () => {
    insert({ sessionId: 'mvs_old', title: 'older', updatedAtMs: 1_000 });
    insert({ sessionId: 'mvs_new', title: 'newer', updatedAtMs: 5_000 });
    insert({ sessionId: 'mvs_mid', title: 'middle', updatedAtMs: 3_000 });

    const entries = listMcodeSessions('/work', { databasePath: dbPath });

    expect(entries.map((e) => e.sessionId)).toEqual(['mvs_new', 'mvs_mid', 'mvs_old']);
    expect(entries[0]).toEqual({ sessionId: 'mvs_new', preview: 'newer', mtime: 5_000 });
  });

  it('only returns sessions belonging to the requested workspace', () => {
    insert({ sessionId: 'mvs_here', title: 'here', workspaceDir: '/work' });
    insert({ sessionId: 'mvs_elsewhere', title: 'elsewhere', workspaceDir: '/other' });

    const entries = listMcodeSessions('/work', { databasePath: dbPath });

    expect(entries.map((e) => e.sessionId)).toEqual(['mvs_here']);
  });

  it('skips archived sessions', () => {
    insert({ sessionId: 'mvs_live', title: 'live' });
    insert({ sessionId: 'mvs_archived', title: 'archived', archived: 1 });

    const entries = listMcodeSessions('/work', { databasePath: dbPath });

    expect(entries.map((e) => e.sessionId)).toEqual(['mvs_live']);
  });

  it('uses the title (the first user message) as the resume preview and flattens whitespace', () => {
    insert({
      sessionId: 'mvs_multi',
      title: '  fix   the\n flaky test  in\n\nparser.ts ',
    });

    const entry = first(listMcodeSessions('/work', { databasePath: dbPath }));

    expect(entry.preview).toBe('fix the flaky test in parser.ts');
  });

  it('truncates an over-long preview with an ellipsis', () => {
    insert({ sessionId: 'mvs_long', title: 'x'.repeat(200) });

    const entry = first(listMcodeSessions('/work', { databasePath: dbPath }));

    expect(entry.preview).toHaveLength(80);
    expect(entry.preview.endsWith('…')).toBe(true);
  });

  it('shows what the user asked, not the bridge system prompt that precedes it', () => {
    // The bridge adapter prepends its system prompt to the user's turn, so
    // mcode's first-user-message title starts with that header. The `/resume`
    // card must show the question instead, or every row reads identically.
    insert({
      sessionId: 'mvs_bridged',
      title: `${BRIDGE_SYSTEM_PROMPT}\n\n## user_message\n\n帮我把 README 的标题改一下`,
    });

    const entry = first(listMcodeSessions('/work', { databasePath: dbPath }));

    expect(entry.preview).toBe('帮我把 README 的标题改一下');
  });

  it('keeps the raw title when the bridge prefix is absent (session started outside the bridge)', () => {
    insert({ sessionId: 'mvs_plain', title: 'plain title' });

    const entry = first(listMcodeSessions('/work', { databasePath: dbPath }));

    expect(entry.preview).toBe('plain title');
  });

  it('labels a title-less session rather than rendering a blank row', () => {
    insert({ sessionId: 'mvs_blank', title: null });

    const entry = first(listMcodeSessions('/work', { databasePath: dbPath }));

    expect(entry.preview).toBe('(无标题会话)');
  });

  it('falls back to created_at_ms when updated_at_ms is missing', () => {
    db.prepare(
      `INSERT INTO ${TABLE} (session_id, title, created_at_ms, updated_at_ms, workspace_dir, status, archived)
       VALUES ('mvs_stale', 'stale', 777, NULL, '/work', 'idle', 0)`,
    ).run();

    const entry = first(listMcodeSessions('/work', { databasePath: dbPath }));

    expect(entry.mtime).toBe(777);
  });

  it('honours the limit', () => {
    for (let i = 0; i < 8; i += 1) {
      insert({ sessionId: `mvs_${i}`, title: `t${i}`, updatedAtMs: i });
    }

    expect(listMcodeSessions('/work', { databasePath: dbPath, limit: 3 })).toHaveLength(3);
  });

  it('returns an empty list when the database does not exist instead of throwing', () => {
    expect(
      listMcodeSessions('/work', { databasePath: join(root, 'missing.sqlite') }),
    ).toEqual([]);
  });

  it('returns an empty list when the expected table is missing (schema drift degrades quietly)', () => {
    db.exec('DROP TABLE local_runtime_sessions');

    expect(listMcodeSessions('/work', { databasePath: dbPath })).toEqual([]);
  });

  it('resolves a workspace through its realpath when an exact match finds nothing', () => {
    insert({ sessionId: 'mvs_real', title: 'via realpath', workspaceDir: root });

    const entries = listMcodeSessionsForCwd(`${root}/./`, { databasePath: dbPath });

    expect(entries.map((e) => e.sessionId)).toEqual(['mvs_real']);
  });
});

describe('mcode data dir resolution', () => {
  it('prefers MINIMAX_DATA_DIR, matching what mcode itself honours', () => {
    expect(resolveMcodeDataDir({ MINIMAX_DATA_DIR: '/custom' } as NodeJS.ProcessEnv)).toBe('/custom');
  });

  it('accepts the MAVIS_DATA_DIR alias', () => {
    expect(resolveMcodeDataDir({ MAVIS_DATA_DIR: '/alias' } as NodeJS.ProcessEnv)).toBe('/alias');
  });

  it('ignores a blank override so an empty env var cannot produce a bogus path', () => {
    expect(
      resolveMcodeDataDir({ MINIMAX_DATA_DIR: '   ' } as NodeJS.ProcessEnv),
    ).toContain('.minimax');
  });

  it('builds the v2 sqlite path under the data dir', () => {
    const dbPath = resolveMcodeDatabasePath({ MINIMAX_DATA_DIR: '/custom' } as NodeJS.ProcessEnv);

    expect(dbPath).toBe(join('/custom', 'v2', 'sqlite', 'runtime-state.sqlite'));
  });
});
