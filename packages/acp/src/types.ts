/**
 * The ACP wire types, written against `refs/acp/schema.v1.json` (see `refs/acp/SOURCE.md` for
 * the pinned upstream commit). `scripts/check-schema.mjs` fails the build when the schema and
 * this file disagree about a method name or a required field.
 *
 * Two rules shape every type in this file, and both come from measurements rather than taste:
 *
 * 1. **Unknown fields are never an error.** ACP is a wire protocol between two programs that
 *    version independently, and `_meta` is the officially reserved place for extensions. Real
 *    agents send keys this file has never heard of: `opencode acp` 2.0.19 answers `initialize`
 *    with `agentCapabilities.sessionCapabilities.fork` and `_meta["opencode/child-session-updates"]`,
 *    neither of which is in the v1 schema. A client that validated strictly would refuse the very
 *    agent it was built for. So every object type carries an index signature and `_meta` is
 *    carried as `unknown`, never interpreted.
 * 2. **Only what the schema marks required is required.** Everything else is optional or
 *    nullable, exactly as the schema says — a required field here that the schema marks
 *    optional would reject valid agents, and a missing one would send invalid requests.
 */

// ─── Primitives ────────────────────────────────────────────────────────────────────────────

/** ACP `RequestId`: JSON-RPC allows a number or a string (and `null`, which we never send). */
export type RequestId = number | string;

/** ACP `SessionId`. An opaque string — the agent owns its shape, kurier never parses it. */
export type SessionId = string;

/** ACP `ProtocolVersion`. Bumped only for breaking changes. */
export type ProtocolVersion = number;

/** The protocol version this package implements. See `refs/acp/SOURCE.md` on v1 vs v2. */
export const PROTOCOL_VERSION: ProtocolVersion = 1;

/**
 * The `_meta` bag ACP reserves on every request, response and notification. Implementations
 * MUST NOT assume anything about its contents, and neither does kurier: it is passed through
 * untouched and never read.
 */
export type Meta = Record<string, unknown> | null;

/** Every ACP struct allows extra keys. See rule 1 in the file header. */
export interface Extensible {
  _meta?: Meta;
  [key: string]: unknown;
}

// ─── initialize ─────────────────────────────────────────────────────────────────────────────

export interface Implementation extends Extensible {
  name: string;
  version: string;
  /** Human-readable name for a UI. Falls back to `name`. */
  title?: string | null;
}

export interface FileSystemCapabilities extends Extensible {
  readTextFile?: boolean;
  writeTextFile?: boolean;
}

export interface AuthCapabilities extends Extensible {
  terminal?: boolean;
}

export interface LogoutCapabilities extends Extensible {}

/** The agent's `agentCapabilities.auth`. Empty object means "no logout". */
export interface AgentAuthCapabilities extends Extensible {
  logout?: LogoutCapabilities | null;
}

export interface ClientSessionCapabilities extends Extensible {
  configOptions?: Extensible | null;
}

export interface ElicitationCapabilities extends Extensible {}

/**
 * What *we* can do, announced in `initialize`. kurier answers `false` to both file-system
 * capabilities on purpose — see `KURIER_CLIENT_CAPABILITIES` and the reasoning in
 * `packages/acp/src/gate.ts`.
 */
export interface ClientCapabilities extends Extensible {
  fs?: FileSystemCapabilities;
  terminal?: boolean;
  session?: ClientSessionCapabilities | null;
  auth?: AuthCapabilities;
  elicitation?: ElicitationCapabilities | null;
}

export interface InitializeRequest extends Extensible {
  protocolVersion: ProtocolVersion;
  clientCapabilities?: ClientCapabilities;
  clientInfo?: Implementation | null;
}

/**
 * `AuthMethod` in the schema is a tagged union. In practice agents do not always send the tag:
 * `opencode acp` sends `{ id, name, description }` with no `type`, which is the *agent* variant
 * plus a `description` the schema does not define. Both variants therefore land in
 * `AuthMethodInfo`, and `kind` is what kurier *reads* (`terminal` → the agent can run the login
 * itself), not what it trusts.
 */
export interface AuthMethodInfo extends Extensible {
  id: string;
  name: string;
  description?: string;
  /** `terminal` when the agent advertises the tag, `agent` otherwise. A guess, deliberately. */
  kind: 'terminal' | 'agent';
  /** Only meaningful for `kind: 'terminal'` — the command the agent wants the CLIENT to run. */
  args?: string[];
  env?: Record<string, string>;
}

export interface PromptCapabilities extends Extensible {
  image?: boolean;
  audio?: boolean;
  embeddedContext?: boolean;
}

export interface McpCapabilities extends Extensible {
  http?: boolean;
  sse?: boolean;
}

/** Every `sessionCapabilities.*` entry is an empty marker object: present means supported. */
export type SessionCapabilityMarker = Extensible;

export interface SessionCapabilities extends Extensible {
  list?: SessionCapabilityMarker | null;
  delete?: SessionCapabilityMarker | null;
  additionalDirectories?: SessionCapabilityMarker | null;
  resume?: SessionCapabilityMarker | null;
  close?: SessionCapabilityMarker | null;
}

export interface AgentCapabilities extends Extensible {
  loadSession?: boolean;
  promptCapabilities?: PromptCapabilities;
  mcpCapabilities?: McpCapabilities;
  sessionCapabilities?: SessionCapabilities;
  auth?: AgentAuthCapabilities;
}

export interface InitializeResponse extends Extensible {
  protocolVersion: ProtocolVersion;
  agentCapabilities?: AgentCapabilities;
  authMethods?: AuthMethodInfo[];
  agentInfo?: Implementation | null;
}

// ─── authenticate ───────────────────────────────────────────────────────────────────────────

export interface AuthenticateRequest extends Extensible {
  methodId: string;
}

export type AuthenticateResponse = Extensible;

// ─── MCP servers, passed through to `session/new` ───────────────────────────────────────────

export interface EnvVariable extends Extensible {
  name: string;
  value: string;
}

export interface HttpHeader extends Extensible {
  name: string;
  value: string;
}

export interface McpServerStdio extends Extensible {
  name: string;
  command: string;
  args: string[];
  env: EnvVariable[];
}

export interface McpServerHttp extends Extensible {
  type: 'http';
  name: string;
  url: string;
  headers: HttpHeader[];
}

export interface McpServerSse extends Extensible {
  type: 'sse';
  name: string;
  url: string;
  headers: HttpHeader[];
}

/**
 * The stdio variant has no `type` in the schema (it is the `anyOf` tail, not a tagged branch).
 * kurier does not care which shape arrived; it forwards the object and never reads past `type`.
 */
export type McpServer = (McpServerStdio & { type?: 'stdio' }) | McpServerHttp | McpServerSse;

// ─── session lifecycle ──────────────────────────────────────────────────────────────────────

export interface SessionMode extends Extensible {
  id: string;
  name: string;
  description?: string | null;
}

export interface SessionModeState extends Extensible {
  currentModeId: string;
  availableModes: SessionMode[];
}

export interface SessionConfigOption extends Extensible {
  id: string;
  name: string;
  [key: string]: unknown;
}

export interface NewSessionRequest extends Extensible {
  cwd: string;
  mcpServers: McpServer[];
  additionalDirectories?: string[];
}

export interface NewSessionResponse extends Extensible {
  sessionId: SessionId;
  modes?: SessionModeState | null;
  configOptions?: SessionConfigOption[] | null;
}

export interface LoadSessionRequest extends Extensible {
  sessionId: SessionId;
  cwd: string;
  mcpServers: McpServer[];
  additionalDirectories?: string[];
}

export type LoadSessionResponse = Extensible;

export interface ResumeSessionRequest extends Extensible {
  sessionId: SessionId;
  cwd: string;
  mcpServers?: McpServer[];
  additionalDirectories?: string[];
}

export type ResumeSessionResponse = Extensible;

export interface ListSessionsRequest extends Extensible {
  cwd?: string | null;
  cursor?: string | null;
}

export interface SessionInfo extends Extensible {
  sessionId: SessionId;
  cwd: string;
  additionalDirectories?: string[];
  title?: string | null;
  updatedAt?: string | null;
}

export interface ListSessionsResponse extends Extensible {
  sessions: SessionInfo[];
  nextCursor?: string | null;
}

export interface CloseSessionRequest extends Extensible {
  sessionId: SessionId;
}

export type CloseSessionResponse = Extensible;

export interface DeleteSessionRequest extends Extensible {
  sessionId: SessionId;
}

export type DeleteSessionResponse = Extensible;

export interface CancelNotification extends Extensible {
  sessionId: SessionId;
}

// ─── prompt turn ────────────────────────────────────────────────────────────────────────────

/**
 * The five content blocks. Each carries its own `type` tag rather than getting it from the union
 * wrapper, which is what lets `content.type === 'text'` narrow `content.text` to a `string` — with
 * the tag only on the wrapper, every field of every variant reads as `unknown` through the
 * `Extensible` index signature and every consumer needs a cast.
 */
export interface TextContent extends Extensible {
  type: 'text';
  text: string;
  annotations?: Extensible | null;
}

export interface ImageContent extends Extensible {
  type: 'image';
  data: string;
  mimeType: string;
  uri?: string | null;
}

export interface AudioContent extends Extensible {
  type: 'audio';
  data: string;
  mimeType: string;
}

export interface ResourceLink extends Extensible {
  type: 'resource_link';
  name: string;
  uri: string;
  description?: string | null;
  mimeType?: string | null;
}

export interface TextResourceContents extends Extensible {
  text: string;
  uri?: string | null;
  mimeType?: string | null;
}

export interface EmbeddedResource extends Extensible {
  type: 'resource';
  resource: TextResourceContents | BlobResourceContents;
}

export interface BlobResourceContents extends Extensible {
  blob: string;
  uri?: string | null;
  mimeType?: string | null;
}

export type ContentBlock = TextContent | ImageContent | AudioContent | ResourceLink | EmbeddedResource;

/** The one content block type kurier itself can put on the wire. */
export function textBlock(text: string): TextContent {
  return { type: 'text', text };
}

export interface PromptRequest extends Extensible {
  sessionId: SessionId;
  prompt: ContentBlock[];
}

/** Why the agent stopped. `cancelled` is the answer a `session/cancel` must produce. */
export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

export interface PromptResponse extends Extensible {
  stopReason: StopReason;
}

// ─── the agent's stream of session updates ──────────────────────────────────────────────────

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export type ToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

export interface ToolCallLocation extends Extensible {
  path: string;
  line?: number | null;
}

export interface ToolCallContent extends Extensible {
  type: string;
  content?: unknown;
}

export interface ToolCall extends Extensible {
  toolCallId: string;
  title: string;
  kind?: ToolKind;
  status?: ToolCallStatus;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface ToolCallUpdate extends Extensible {
  toolCallId: string;
  status?: ToolCallStatus;
  title?: string;
  kind?: ToolKind;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface ContentChunk extends Extensible {
  content: ContentBlock;
}

export type PlanEntryStatus = 'pending' | 'in_progress' | 'completed';
export type PlanEntryPriority = 'high' | 'medium' | 'low';

export interface PlanEntry extends Extensible {
  content: string;
  priority?: PlanEntryPriority;
  status?: PlanEntryStatus;
}

export interface Plan extends Extensible {
  entries: PlanEntry[];
}

export interface AvailableCommand extends Extensible {
  name: string;
  description?: string;
  input?: unknown;
}

export interface AvailableCommandsUpdate extends Extensible {
  availableCommands: AvailableCommand[];
}

export interface CurrentModeUpdate extends Extensible {
  currentModeId: string;
}

export interface SessionInfoUpdate extends Extensible {
  title?: string | null;
}

export interface Cost extends Extensible {
  amount: number;
  currency?: string;
}

export interface UsageUpdate extends Extensible {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: Cost | null;
}

/**
 * The `session/update` payloads kurier understands, discriminated on `sessionUpdate`.
 *
 * The schema declares this as a `oneOf` with a `discriminator`, and so do we — deliberately, with
 * **no catch-all branch**. A catch-all arm typed `{ sessionUpdate: string }` overlaps every literal,
 * so TypeScript cannot narrow `update.content` past `unknown` and every consumer needs a cast at
 * every field. The price is one explicit narrowing function for the case that actually happens (a
 * newer agent), which is much cheaper than casts everywhere.
 *
 * @see narrowSessionUpdate — the one place an unknown variant becomes visible.
 */
export type KnownSessionUpdate =
  | ({ sessionUpdate: 'user_message_chunk' } & ContentChunk)
  | ({ sessionUpdate: 'agent_message_chunk' } & ContentChunk)
  | ({ sessionUpdate: 'agent_thought_chunk' } & ContentChunk)
  | ({ sessionUpdate: 'tool_call' } & ToolCall)
  | ({ sessionUpdate: 'tool_call_update' } & ToolCallUpdate)
  | ({ sessionUpdate: 'plan' } & Plan)
  | ({ sessionUpdate: 'available_commands_update' } & AvailableCommandsUpdate)
  | ({ sessionUpdate: 'current_mode_update' } & CurrentModeUpdate)
  | ({ sessionUpdate: 'config_option_update' } & Extensible)
  | ({ sessionUpdate: 'session_info_update' } & SessionInfoUpdate)
  | ({ sessionUpdate: 'usage_update' } & UsageUpdate);

/** Every `sessionUpdate` value the v1 schema defines. */
export const SESSION_UPDATE_KINDS = [
  'user_message_chunk',
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
  'available_commands_update',
  'current_mode_update',
  'config_option_update',
  'session_info_update',
  'usage_update',
] as const;

/** What a consumer sees: the known variants, with their fields typed. */
export type SessionUpdate = KnownSessionUpdate;

/** What may actually arrive: the known variants plus whatever a newer agent invented. */
export type AnySessionUpdate = KnownSessionUpdate | ({ sessionUpdate: string } & Extensible);

export interface SessionNotification extends Extensible {
  sessionId: SessionId;
  update: KnownSessionUpdate;
}

// ─── what the agent may ask the client ──────────────────────────────────────────────────────

export type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';

export interface PermissionOption extends Extensible {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
}

export interface ReadTextFileRequest extends Extensible {
  sessionId: SessionId;
  path: string;
  line?: number | null;
  limit?: number | null;
}

export interface ReadTextFileResponse extends Extensible {
  content: string;
}

export interface WriteTextFileRequest extends Extensible {
  sessionId: SessionId;
  path: string;
  content: string;
}

export type WriteTextFileResponse = Extensible;

export interface RequestPermissionRequest extends Extensible {
  sessionId: SessionId;
  toolCall: ToolCallUpdate;
  options: PermissionOption[];
}

/** `cancelled` — the turn was cancelled, so no option was chosen. */
export interface PermissionOutcomeCancelled extends Extensible {
  outcome: 'cancelled';
}

/** `selected` — the option the client chose. Which option is the client's decision, always. */
export interface PermissionOutcomeSelected extends Extensible {
  outcome: 'selected';
  optionId: string;
}

export type RequestPermissionOutcome = PermissionOutcomeCancelled | PermissionOutcomeSelected;

export interface RequestPermissionResponse extends Extensible {
  outcome: RequestPermissionOutcome;
}

export interface CreateElicitationRequest extends Extensible {
  sessionId: SessionId;
  message: string;
}

export interface CreateElicitationResponse extends Extensible {
  action: string;
  content?: unknown;
}

// ─── errors ─────────────────────────────────────────────────────────────────────────────────

/** ACP `ErrorCode` plus the JSON-RPC codes the transport itself can produce. */
export const ERROR_CODES = {
  /** Not a JSON line at all. */
  PARSE_ERROR: -32_700,
  INVALID_REQUEST: -32_600,
  METHOD_NOT_FOUND: -32_601,
  INVALID_PARAMS: -32_602,
  INTERNAL_ERROR: -32_603,
  /** `$/cancel_request`. */
  REQUEST_CANCELLED: -32_800,
  /** The agent wants a human to log in first. Trap 1 of the plan — `kurier auth`. */
  AUTH_REQUIRED: -32_000,
  RESOURCE_NOT_FOUND: -32_002,
} as const;

export interface WireError extends Extensible {
  code: number;
  message: string;
  data?: unknown;
}
