// Public exports for consumers that need the same rendering logic the bot uses.
export { renderCard } from './card/run-renderer';
export { renderText } from './card/text-renderer';
export {
  initialState,
  reduce,
  finalizeIfRunning,
  markInterrupted,
} from './card/run-state';
export type { RunState, ToolEntry, Block, ToolStatus, Terminal, FooterStatus } from './card/run-state';

// The agent adapter itself, so an embedding program (or the e2e smoke script)
// can drive a real mcode session with the same translation the bot uses.
export { McodeAdapter } from './agent/mcode/adapter';
export { buildMcodeArgs } from './agent/mcode/argv';
export { McodeStreamTranslator, translateStream } from './agent/mcode/stream-json';
export { listMcodeSessions, listMcodeSessionsForCwd } from './agent/mcode/session-history';
export type { McodeSessionSummary } from './agent/mcode/session-history';
export type {
  AgentAdapter,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from './agent/types';
export { mcodeCapability } from './agent/capability';
export type { McodePermissionPolicy } from './config/permissions';

// Optional telemetry hook (see README "Optional telemetry"). Types let an
// external adapter package implement the interface via `import type`; the
// runtime helpers are noop unless LARK_CHANNEL_TELEMETRY_MODULE is set.
export type {
  TelemetryAdapter,
  AdapterFactory,
  AdapterMeta,
  TelemetryEvent,
} from './core/telemetry';
export { reportMetric, reportError } from './core/logger';
