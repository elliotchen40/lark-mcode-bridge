import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { mergeProcessEnv } from '../../../src/platform/spawn.js';

describe('platform spawn env', () => {
  it('overrides env keys case-insensitively for Windows-compatible env handling', () => {
    const env = mergeProcessEnv(
      {
        Path: '/bin',
        Minimax_Data_Dir: '/old-data-dir',
        LARK_CHANNEL: '0',
      },
      {
        MINIMAX_DATA_DIR: '/new-data-dir',
        LARK_CHANNEL: '1',
      },
    );

    expect(env.MINIMAX_DATA_DIR).toBe('/new-data-dir');
    expect(env.LARK_CHANNEL).toBe('1');
    // A differently-cased duplicate would confuse Node on Windows, where env
    // keys are case-insensitive.
    expect(Object.keys(env).filter((key) => key.toLowerCase() === 'minimax_data_dir')).toEqual([
      'MINIMAX_DATA_DIR',
    ]);
  });

  it('the mcode adapter spawns through cross-spawn, never a raw shell', async () => {
    const source = await readFile(
      new URL('../../../src/agent/mcode/adapter.ts', import.meta.url),
      'utf8',
    );

    expect(source).toContain("from '../../platform/spawn'");
    expect(source).not.toContain("from 'node:child_process'");
    expect(source).not.toContain('shell: true');
  });

  it('the mcode adapter keeps the prompt out of argv, which the Windows shim would mangle', async () => {
    // `mcode` resolves to a `.cmd` shim on Windows and cross-spawn routes those
    // through `cmd.exe /d /s /c`, where `<` and `>` are redirection operators.
    // The bridge system prompt and quoted chat content are full of XML-ish tags,
    // so argv delivery would silently truncate the request.
    const [adapter, argv] = await Promise.all([
      readFile(new URL('../../../src/agent/mcode/adapter.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../../src/agent/mcode/argv.ts', import.meta.url), 'utf8'),
    ]);

    expect(adapter).toContain('child.stdin.end(');
    expect(argv).toContain("'--input', '-'");
    // argv.ts must never place the prompt itself into the argument list.
    expect(argv).not.toMatch(/args\.push\([^)]*prompt/i);
    expect(argv).not.toMatch(/args\.push\([^)]*systemPrompt/i);
  });
});
