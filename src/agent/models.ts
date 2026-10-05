/**
 * Sentinel selection meaning "don't pass `--model`; let mcode / the account
 * decide". Kept as a real option value (rather than empty string) because
 * Feishu's `select_static` requires `initial_option` to match one of the option
 * `value`s exactly and rejects an empty string.
 */
export const DEFAULT_MODEL = 'default';

export interface ModelOption {
  /**
   * Stored in `preferences.model` and forwarded to `mcode exec --model`.
   * `DEFAULT_MODEL` is special-cased to omit the flag entirely.
   */
  value: string;
  /** Human-facing label shown in the `/config` picker. */
  label: string;
}

/**
 * mcode models.
 *
 * `--model` takes a `provider/model` id, so these are qualified with the
 * `minimax` provider rather than being bare model names. The list mirrors the
 * ids mcode ships in its provider config; the account's own `config.yaml`
 * (`defaultModel` / `provider.*.models`) remains the source of truth, and
 * leaving the selection at {@link DEFAULT_MODEL} follows whatever the account
 * has configured — including custom providers this list does not know about.
 */
const MCODE_MODELS: ModelOption[] = [
  { value: DEFAULT_MODEL, label: '跟随默认（不指定）' },
  { value: 'minimax/MiniMax-M3.1-Flash-Preview', label: 'MiniMax M3.1 Flash Preview（默认）' },
  { value: 'minimax/MiniMax-M3', label: 'MiniMax M3' },
  { value: 'minimax/MiniMax-M2.7-highspeed', label: 'MiniMax M2.7 Highspeed' },
  { value: 'minimax/MiniMax-M2.7', label: 'MiniMax M2.7' },
];

/** The model picker options for a profile. */
export function supportedModels(): ModelOption[] {
  return MCODE_MODELS;
}

/** True when the selection means "use the agent default" (no `--model`). */
export function isDefaultModel(value: string | undefined): boolean {
  return !value || value === DEFAULT_MODEL;
}

/**
 * Coerce a stored model preference into a value guaranteed to be one of the
 * current picker options — Feishu's `select_static` requires `initial_option`
 * to match an option value exactly. Unknown values (e.g. a custom provider's
 * model, or a model id that has since been renamed) fall back to
 * {@link DEFAULT_MODEL}.
 */
export function normalizeModelSelection(value: string | undefined): string {
  if (isDefaultModel(value)) return DEFAULT_MODEL;
  return supportedModels().some((m) => m.value === value) ? (value as string) : DEFAULT_MODEL;
}

/**
 * Resolve the concrete model string to hand the agent, or `undefined` to omit
 * the `--model` flag. Unknown values are treated as "default".
 */
export function resolveModelArg(value: string | undefined): string | undefined {
  const normalized = normalizeModelSelection(value);
  return normalized === DEFAULT_MODEL ? undefined : normalized;
}

/** Picker label for a stored value, for display in the saved-config card. */
export function modelLabel(value: string | undefined): string {
  const normalized = normalizeModelSelection(value);
  return supportedModels().find((m) => m.value === normalized)?.label ?? normalized;
}
