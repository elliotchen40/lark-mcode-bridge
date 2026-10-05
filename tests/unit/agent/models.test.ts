import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL,
  isDefaultModel,
  modelLabel,
  normalizeModelSelection,
  resolveModelArg,
  supportedModels,
} from '../../../src/agent/models.js';

describe('agent model catalog', () => {
  it('offers a single mcode catalog led by the default sentinel', () => {
    const models = supportedModels();
    expect(models[0]?.value).toBe(DEFAULT_MODEL);
    expect(models.map((m) => m.value)).toContain('minimax/MiniMax-M3');
    // Every concrete option is a qualified `provider/model` id.
    expect(models.filter((m) => m.value !== DEFAULT_MODEL).every((m) => m.value.includes('/'))).toBe(
      true,
    );
    // No leftovers from the agents this bridge no longer drives.
    expect(models.map((m) => m.value)).not.toContain('gpt-5-codex');
    expect(models.map((m) => m.value)).not.toContain('claude-opus-4-8');
  });

  it('treats unset and the default sentinel as "use agent default"', () => {
    expect(isDefaultModel(undefined)).toBe(true);
    expect(isDefaultModel('')).toBe(true);
    expect(isDefaultModel(DEFAULT_MODEL)).toBe(true);
    expect(isDefaultModel('minimax/MiniMax-M3')).toBe(false);
  });

  it('coerces unknown / renamed selections back to the default option', () => {
    expect(normalizeModelSelection('minimax/MiniMax-M3')).toBe('minimax/MiniMax-M3');
    // A model id that is no longer offered (e.g. left over from a profile
    // written for another agent) must not reach the picker.
    expect(normalizeModelSelection('gpt-5-codex')).toBe(DEFAULT_MODEL);
    expect(normalizeModelSelection(undefined)).toBe(DEFAULT_MODEL);
  });

  it('resolves the --model argument, omitting it for the default', () => {
    expect(resolveModelArg('minimax/MiniMax-M2.7')).toBe('minimax/MiniMax-M2.7');
    expect(resolveModelArg(DEFAULT_MODEL)).toBeUndefined();
    expect(resolveModelArg(undefined)).toBeUndefined();
    // Unknown value → no flag rather than a broken model.
    expect(resolveModelArg('gpt-5-codex')).toBeUndefined();
  });

  it('labels a stored value using the picker option text', () => {
    expect(modelLabel('minimax/MiniMax-M3')).toBe('MiniMax M3');
    expect(modelLabel(DEFAULT_MODEL)).toContain('跟随默认');
  });
});
