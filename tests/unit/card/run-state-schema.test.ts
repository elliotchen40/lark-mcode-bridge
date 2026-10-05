import { describe, expect, it } from 'vitest';
import { initialState, reduce } from '../../../src/card/run-state';

describe('run state terminal event schema', () => {
  it('maps done termination reasons onto visible terminal states', () => {
    expect(reduce(initialState, { type: 'done', terminationReason: 'normal' }).terminal).toBe(
      'done',
    );
    expect(
      reduce(initialState, { type: 'done', terminationReason: 'interrupted' }).terminal,
    ).toBe('interrupted');
    expect(reduce(initialState, { type: 'done', terminationReason: 'timeout' }).terminal).toBe(
      'idle_timeout',
    );
  });

  it('maps error termination reasons onto visible terminal states', () => {
    expect(
      reduce(initialState, {
        type: 'error',
        message: 'failed',
        terminationReason: 'failed',
      }).terminal,
    ).toBe('error');
    expect(
      reduce(initialState, {
        type: 'error',
        message: 'stopped',
        terminationReason: 'interrupted',
      }).terminal,
    ).toBe('interrupted');
    expect(
      reduce(initialState, {
        type: 'error',
        message: 'timeout',
        terminationReason: 'timeout',
      }).terminal,
    ).toBe('idle_timeout');
  });
});

describe('run state final_text handling', () => {
  it('surfaces a final answer that arrived with no streamed text delta', () => {
    // mcode reports `result.output` on every successful exec, including turns
    // that streamed nothing. Without this, the card rendered "（未返回内容）"
    // and the user got silence.
    const state = reduce(initialState, {
      type: 'final_text',
      content: 'FINAL_ONLY',
    });

    expect(state.finalText).toBe('FINAL_ONLY');
    expect(state.blocks).toEqual([
      { kind: 'text', content: 'FINAL_ONLY', streaming: false },
    ]);
  });

  it('does not duplicate the answer when the same words already streamed as deltas', () => {
    const streamed = reduce(initialState, { type: 'text', delta: 'ANSWER' });
    const state = reduce(streamed, { type: 'final_text', content: 'ANSWER' });

    expect(state.finalText).toBe('ANSWER');
    expect(state.blocks).toEqual([{ kind: 'text', content: 'ANSWER', streaming: true }]);
  });

  it('keeps tool entries and appends the final answer after them', () => {
    const withTool = reduce(initialState, {
      type: 'tool_use',
      id: 'c1',
      name: 'bash',
      input: { command: 'ls' },
    });
    const state = reduce(withTool, { type: 'final_text', content: 'done listing' });

    expect(state.blocks.map((b) => b.kind)).toEqual(['tool', 'text']);
  });

  it('adds nothing for an empty final answer', () => {
    const state = reduce(initialState, { type: 'final_text', content: '' });

    expect(state.blocks).toEqual([]);
    expect(state.finalText).toBe('');
  });
});
