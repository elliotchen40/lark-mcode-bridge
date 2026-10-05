import { describe, expect, it } from 'vitest';
import { buildMcodeArgs } from '../../../src/agent/mcode/argv';

describe('buildMcodeArgs', () => {
  it('pins the run to stream-json, the permission policy and the cwd', () => {
    expect(buildMcodeArgs({ cwd: '/work', permission: 'full' })).toEqual([
      'exec',
      '--output-format',
      'stream-json',
      '--permission',
      'full',
      '--cwd',
      '/work',
      '--input',
      '-',
    ]);
  });

  it('reads the prompt from stdin so no shell ever sees the prompt', () => {
    // The bridge system prompt and quoted chat content are full of `<...>` tags.
    // On Windows `mcode` resolves to a .cmd shim, which cross-spawn routes via
    // `cmd.exe /d /s /c`, where `<` and `>` are redirection operators — a prompt
    // passed in argv would be silently truncated. `--input -` is what makes the
    // prompt argv-free.
    const args = buildMcodeArgs({ cwd: '/work', permission: 'smart' });

    expect(args).toContain('-');
    expect(args[args.length - 2]).toBe('--input');
    expect(args.at(-1)).toBe('-');
  });

  it('appends the session id so the next turn continues the same mcode session', () => {
    const args = buildMcodeArgs({
      cwd: '/work',
      permission: 'full',
      sessionId: 'mvs_abc123',
    });

    expect(args).toEqual(expect.arrayContaining(['--session', 'mvs_abc123']));
  });

  it('omits the model flag when no model is selected so mcode uses the account default', () => {
    const args = buildMcodeArgs({ cwd: '/work', permission: 'full' });

    expect(args).not.toContain('--model');
  });

  it('forwards an explicit model id', () => {
    const args = buildMcodeArgs({
      cwd: '/work',
      permission: 'full',
      model: 'minimax/MiniMax-M3',
    });

    expect(args).toEqual(
      expect.arrayContaining(['--model', 'minimax/MiniMax-M3']),
    );
  });

  it('repeats --file for every attachment, since mcode takes images and documents alike', () => {
    const args = buildMcodeArgs({
      cwd: '/work',
      permission: 'full',
      files: ['/tmp/a.png', '/tmp/b.pdf'],
    });

    expect(args.filter((a) => a === '--file')).toHaveLength(2);
    expect(args).toEqual(expect.arrayContaining(['--file', '/tmp/a.png', '--file', '/tmp/b.pdf']));
  });

  it('supports an explicit step cap and reasoning effort', () => {
    const args = buildMcodeArgs({
      cwd: '/work',
      permission: 'full',
      effort: 'high',
      maxSteps: 12,
    });

    expect(args).toEqual(
      expect.arrayContaining(['--effort', 'high', '--max-steps', '12']),
    );
  });

  it('rejects a permission policy mcode does not understand', () => {
    // `ask` is intentionally unsupported: mcode only offers interactive approval
    // in the TUI / ACP transports, never in headless `exec`.
    expect(() =>
      buildMcodeArgs({ cwd: '/work', permission: 'ask' as never }),
    ).toThrow(/invalid mcode permission policy/);
  });

  it('rejects an empty cwd rather than letting the run inherit the bridge cwd', () => {
    expect(() => buildMcodeArgs({ cwd: '   ', permission: 'full' })).toThrow(/cwd is required/);
  });

  it('places --input last so a stray positional can never become the review subcommand', () => {
    const args = buildMcodeArgs({
      cwd: '/work',
      permission: 'full',
      sessionId: 'mvs_x',
      model: 'minimax/MiniMax-M3',
      files: ['/tmp/a.png'],
    });

    expect(args.slice(-2)).toEqual(['--input', '-']);
  });
});
