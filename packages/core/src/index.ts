/**
 * `@kurier/core` — kurier without a surface.
 *
 * Layer 2, between the protocol (`@kurier/acp`) and whatever is rendering: which agent to start
 * and how to start it, the session a prompt turn runs in, the view models a chat is drawn from,
 * and the provider login. The CLI, the Adwaita window and an embedded widget are three consumers
 * of the same code, which is the whole reason this package exists — see
 * [ADR 0001](../../../docs/adr/0001-kurier-as-an-embeddable-widget.md).
 *
 * **Nothing here knows a toolkit.** No `gi://`, no yargs, no widget: the pieces that need a
 * decision take it as an argument. Paths arrive as a `KurierPaths`, the agent choice as an
 * `AgentChoice`, the permission answer as a `ClientGate`. That is what lets a host put kurier's
 * conversation in its own data directory, and what keeps every file in here testable on Node as
 * well as on GJS.
 *
 * **One door, and it is this file.** The package exports `.` only, so what a consumer may reach is
 * a decision made here rather than a side effect of the directory layout. An export added below is
 * a promise to the widget and to any host; an internal helper stays internal.
 */

// ── Where kurier keeps things ────────────────────────────────────────────────────────────────────
// The shape, and the layout a host gets. The app's own XDG/`KURIER_*` resolver stays in the app.
export { kurierPathsUnder, type KurierPaths } from './paths.ts';

// ── Which agent, and where its private HOME goes ─────────────────────────────────────────────────
export { describeChoice, type AgentChoice, type AgentChoiceSource } from './agents/choice.ts';
export {
  BUNDLED_AGENTS,
  BUNDLED_CATALOG,
  BUNDLED_PREFIX,
  bundledProgram,
  parseBundledCatalog,
  type BundledAgent,
  type BundledArch,
  type BundledCatalog,
  type BundledDist,
} from './agents/catalog.ts';
export {
  detectAgents,
  parseVersionOutput,
  resolveAgent,
  type AgentDetection,
  type AgentFacts,
  type AgentSource,
  type Resolution,
} from './agents/detect.ts';
export {
  chooseAgent,
  STAND_IN_AGENT_ID,
  standInCommand,
  standInScriptPath,
  STAND_IN_SCRIPT,
  type DevAgentChoice,
} from './agents/dev-agent.ts';
export { isolationDirs, isolationEnv, prepareIsolation, type IsolationDirs } from './agents/isolation.ts';
export { DEFAULT_AGENT, findLauncher, launcherIds, LAUNCHERS, requireLauncher } from './agents/launcher.ts';
export { OPENCODE_COMMAND, OPENCODE_LOGIN } from './agents/opencode.ts';
export {
  gatherAgentFacts,
  gatherAgentFactsAsync,
  gatherCwdFacts,
  gatherResolveContext,
  gatherResolveContextAsync,
} from './agents/probe.ts';
export {
  bundledCommand,
  describeResolved,
  NO_AGENT_MESSAGE,
  resolveDefault,
  resolveDefaultWithNote,
  resolveRecorded,
  sameCommand,
  type DefaultResolution,
  type RecordedResolution,
  type ResolveContext,
  type ResolvedAgent,
  type ResolvedSource,
} from './agents/resolve.ts';
export {
  currentSandboxFacts,
  FLATPAK_SPAWN,
  hostCwdArgv,
  hostProbeArgv,
  isSandboxed,
  toHostCommand,
  type SandboxFacts,
} from './agents/sandbox.ts';
export {
  needsWindowsShell,
  parseHostProbeOutput,
  probeAccepts,
  resolveSpawnCommand,
  StdioChannel,
  stdioTransport,
  which,
  whichAsync,
  type AgentCommand,
  type StdioChannelOptions,
} from './agents/stdio.ts';
export { displayCwd, resolveCwd, type CwdFacts } from './cwd.ts';

// ── Starting an agent, and one prompt turn ───────────────────────────────────────────────────────
export {
  openAgent,
  runTurn,
  withAuthHint,
  type AgentHandle,
  type OpenAgentOptions,
  type TurnOptions,
} from './run.ts';
export {
  AgentSession,
  type AgentSessionEvents,
  type AgentSessionOptions,
  type AgentSnapshot,
  type BoundSession,
} from './agent-session.ts';
export {
  decideInterrupt,
  installInterruptHandler,
  type InterruptAction,
  type InterruptHandle,
  type InterruptHooks,
  type InterruptState,
} from './interrupt.ts';
export {
  conversationRecord,
  titleFromPrompt,
  unsavedMessage,
  type ConversationInput,
} from './conversation.ts';

// ── The login an agent asks for, and the login kurier can arrange ────────────────────────────────
export {
  SERVER_KILL_GRACE_MS,
  SERVER_START_TIMEOUT_MS,
  serverCommand,
  startServer,
  whyNoLoginServer,
  type OpencodeServer,
} from './agents/server.ts';
export {
  createLoginApi,
  LoginApiError,
  type HttpResponse,
  type OpencodeLogin,
  type Send,
} from './login/api.ts';
export {
  answersFor,
  EXPIRY_GRACE_MS,
  MAX_POLL_FAILURES,
  POLL_MS,
  runLogin,
  type LoginApi,
  type LoginHooks,
  type LoginMode,
  type LoginPrompt,
  type LoginResult,
  type OAuthAttempt,
  type OAuthStatus,
} from './login/flow.ts';
export {
  LoginController,
  type LoginControllerDeps,
  type LoginSession,
  type LoginState,
} from './login/controller.ts';
export {
  KEY_METHOD_ID,
  LOGIN_POLICY,
  parseIntegrations,
  parseLoginPolicy,
  type LoginField,
  type LoginFieldCondition,
  type LoginFieldOption,
  type LoginMethod,
  type LoginPolicy,
  type LoginProvider,
} from './login/providers.ts';
export { loginUnavailableReason, openLoginSession } from './login/session.ts';

// ── What a turn is doing, and what went wrong ────────────────────────────────────────────────────
export {
  agentExitedEntry,
  agentName,
  agentStatus,
  isEchoOf,
  isOnScreen,
  leavesRunningTurn,
  permissionDecisionEntry,
  transition,
  type AgentAttachment,
  type AgentStatus,
  type CancelledBy,
  type TurnEvent,
} from './turn.ts';
export {
  AUTH_COMMAND,
  AuthRequiredError,
  failureAction,
  failureKind,
  failureNotice,
  failureToShow,
  isQuotaExhausted,
  staleDialog,
  type FailureAction,
  type FailureActionContext,
  type FailureContext,
  type FailureKind,
  type FailureNotice,
} from './failure.ts';

// ── Answering the agent's permission request ─────────────────────────────────────────────────────
export {
  agentNames,
  answerFor,
  decideFromView,
  escapeMnemonic,
  initialFocusResponseId,
  isKnownOptionKind,
  optionLabel,
  orderOptions,
  PermissionDesk,
  permissionView,
  usableOptions,
  type NotAnsweredReason,
  type PermissionDecision,
  type PermissionQuestion,
  type PermissionView,
} from './permission.ts';
export { chunkToText, describe, terminalGate, type Terminal, type TerminalGateOptions } from './policy.ts';

// ── The view models a chat is drawn from ─────────────────────────────────────────────────────────
export {
  composerView,
  keepsDraft,
  offersStop,
  type ComposerAction,
  type ComposerInput,
  type ComposerView,
  type TurnState,
} from './composer-state.ts';
export {
  configValue,
  currentLabel,
  findControl,
  projectConfigOptions,
  type ConfigControl,
  type ConfigSelectControl,
  type ConfigSwitchControl,
  type ConfigValue,
} from './config.ts';
export {
  applyConfigUpdate,
  configAfterSet,
  configRequest,
  configRowInput,
  configSelection,
  emptyConfigRow,
  isConfigChange,
  modelControl,
  parseConfigOptionSpec,
  REFUSED,
  type ConfigRowControl,
  type ConfigRowInput,
  type ConfigRowView,
  type ConfigSelection,
} from './config-row.ts';
export { FREE_MODEL_IDS, FREE_MODELS, freeModelFirst, type FreeModelList } from './free-models.ts';
export { toTranscript } from './transcript.ts';
export {
  toTranscriptItems,
  type AgentItem,
  type DisclosureItem,
  type SystemItem,
  type ThoughtItem,
  type ToolItem,
  type TranscriptItem,
  type UserItem,
} from './transcript-items.ts';
export { describeUsage, formatCost, formatUsageNumber } from './usage.ts';
export {
  followLanded,
  FOLLOW_MAX_ATTEMPTS,
  followTarget,
  isAtBottom,
  resolveFollow,
  shouldRetryFollow,
  type AdjustmentSignal,
  type FollowInput,
  type FollowUpdate,
} from './scroll.ts';

// ── What the window says when there is no agent, or a notice is owed ─────────────────────────────
export {
  DOCS_URL,
  emptyStateView,
  INSTALL_COMMAND,
  NO_AGENT_REMEDY,
  noticeView,
  type EmptyStateView,
  type NoticeView,
} from './empty-state.ts';
export { noticeDue, NOTICE_IDS, type NoticeId } from './notices.ts';
