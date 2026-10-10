# kurier — Code Review Findings

> **Status as of 2026-10-03.** The body below is the review **as it was written on 2026-09-30**
> against `main` and is kept unedited, because a review that gets rewritten is no longer a record of
> what was found. This header is the only part that moves.
>
> Every finding was re-checked against `main` on 2026-10-03. Six were already fixed by other work:
> #2 (stderr flush on exit), #3 (`resume`'s transcript append), #4 (the buffer-overflow excerpt), #6
> (`runTurn`'s SIGINT on a non-TTY), #8 (the duplicated gate construction) and #14 (`session/update`
> variants in the schema check). #13 and #16 are partly fixed. The rest are open, and the top of that
> list is unchanged: **#1, `StdioChannel.send` ignores backpressure on stdin** — there is no `drain`
> anywhere in the tree, so a large prompt can still be dropped silently.
>
> **One finding here was itself wrong, and the way it was wrong is the point.** #2 is filed as "the
> stderr buffer is not flushed on exit", and the flush was there. The real defect is one level up: the
> channel ended as soon as **stdout** closed, so a last stderr line still in flight arrived *after*
> the end — measured `stdout, END, late-err` on gjs and node alike. Fixed in
> [fix/stdio-stderr-gate](../../pull/6) with a test that fails without it.
>
> **And one defect this review did not look for, found while fixing that one.** `StdioChannel
> .terminate()` cannot end the channel when the agent leaves a child process holding its pipes:
> `SIGTERM`/`SIGKILL` reach the direct child, the grandchild keeps the pipe open, and `onEnd` never
> fires. Measured `PROBE_KILL=NEVER-ENDED` on gjs and on node, **identically before and after** the
> end-gating fix, so it is pre-existing and not a regression — and it means a GUI Stop can leave an
> agent attached forever. SIGKILL cannot cross the process group without a deliberate decision
> (`setsid` at spawn, or a group kill), which is why it is filed here rather than patched. **This is
> the next thing to work on**, and it wants its own test before its own fix.
>
> Three comment claims about `@gjsify/child_process`'s `close`/`exit` ordering were also stale: they
> described 0.53.x, and 0.54.0 waits for the pipes. That wrong claim is what made the end-gating look
> unfixable, and it is what the abandoned `wip/stdio-close-gate` branch was built on.
>
> **Per finding, re-checked against `main` on 2026-10-10.** "Core" marks what blocks or shapes the
> `@lotse/core` extraction.
>
> | #   | Finding                                          | Status                                                     | Core |
> | --- | ------------------------------------------------ | ---------------------------------------------------------- | ---- |
> | 1   | `send` ignores stdin backpressure                | fixed — page-sized writes, stdin `error` handled           | yes  |
> | 2   | stderr not flushed on exit                       | fixed (really end-gating, PR #6)                           |      |
> | 3   | `resume` appends by spread                       | fixed — uses `store.append`                                |      |
> | 4   | overflow loses the excerpt                       | fixed                                                      |      |
> | 5   | gate throw becomes "cancelled"                   | fixed — fail-closed, reported via `#reportError`           |      |
> | 6   | `runTurn` SIGINT on a non-TTY                    | fixed — moved to `core/interrupt.ts`                       |      |
> | 7   | `runInteractively` spawn failure vs exit code    | mostly mitigated — `which` precheck, no ENOENT branch      |      |
> | 8   | duplicated gate construction                     | fixed                                                      |      |
> | 9   | `AuthCapabilities`/`LogoutCapabilities` unused   | partly — logout now used by `client.logout`                |      |
> | 10  | transcript drops two `session/update` kinds      | by design — commented                                      |      |
> | 11  | auth classification in `run.ts`                  | open — `describeAuth` still app-side                       | yes  |
> | 12  | auth flow duplicated in the CLI                  | open                                                       | yes  |
> | 13  | check-schema misses auth/capability shapes       | partly — `AuthMethodInfo`, `SessionCapabilities` checked   |      |
> | 14  | `session/update` variants unchecked              | fixed                                                      |      |
> | 15  | TS-stricter fields only noted                    | open                                                       |      |
> | 16  | "kurier never parses" stderr comment             | partly — new line added, old one still duplicated above it |      |
> | 17  | `AuthMethodInfo.kind` "a guess"                  | open                                                       |      |
> | 18  | `#send` throws, `#write` closes                  | fixed — every failed write closes; split documented        | yes  |
> | 19  | `ClosedTransport.onClose` fires in a microtask   | fixed — listener called synchronously                      | yes  |
> | —   | `terminate()` with a grandchild holding the pipe | fixed — `detached` spawn, process-group kill               | yes  |
> | —   | check-schema in CI                               | fixed — `ci.yml` runs it                                   |      |

Most severe first. Each finding follows the requested format.

---

## 1. Correctness Bugs

### `app/src/core/agents/stdio.ts:113-116` — `StdioChannel.send` ignores backpressure on stdin
```
Evidence: 
  send(data: string): void {
    if (this.#closed) throw new Error(`${this.command.program} is gone — cannot send`);
    this.#child.stdin.write(`${data}\n`);
  }
```
Breaks when: The agent sends a large prompt with embedded resources (images, large diffs) and the child process's stdin buffer fills. `stream.write()` returns `false` when the buffer is full; the caller should await the `'drain'` event. Without this, data is silently dropped or memory grows unbounded.
Fix shape: Await `drain` when `write` returns `false`, or use a write queue.

### `app/src/core/agents/stdio.ts:82-92` — Stderr buffer not flushed on process exit
```
Evidence:
  this.#child.stderr.on('data', (chunk: string) => {
    if (!options.onStderr) return;
    this.#stderrBuffer += chunk;
    let newline: number;
    while ((newline = this.#stderrBuffer.indexOf('\n')) >= 0) {
      const line = this.#stderrBuffer.slice(0, newline);
      this.#stderrBuffer = this.#stderrBuffer.slice(newline + 1);
      if (line.trim()) options.onStderr(line);
    }
  });
```
Breaks when: The agent process exits (or crashes) with a partial line in `#stderrBuffer` (no trailing newline). That final log line is lost — the `exit` handler at line 94-101 does not flush the buffer.
Fix shape: In the `exit` handler, if `#stderrBuffer` is non-empty, pass it to `onStderr` before emitting the end event.

### `app/src/frontends/cli/resume.ts:127` — Transcript append uses manual spread instead of `store.append`
```
Evidence:
  store.update(id, (current) => touch({ ...current, turns: [...current.turns, ...transcript] }, at()));
```
Breaks when: `store.append` exists for exactly this purpose (it calls `appendTurns` which handles the `updatedAt` correctly). Manual spread duplicates logic and can drift — if `appendTurns` changes, `resume.ts` won't reflect it. Also, if the update throws after the spread but before write, the local `transcript` variable is not persisted (though the user saw output).
Fix shape: Use `store.append(id, transcript)` like `start.ts:134` does.

---

## 2. Error Paths Worse Than They Look

### `packages/acp/src/jsonrpc.ts:133-137` — Buffer overflow clears buffer but loses diagnostic context
```
Evidence:
  if (this.#buffer.length > this.#maxLineLength) {
    const overflow = this.#buffer.length;
    this.#buffer = '';
    throw new ProtocolError(`no line ending after ${overflow} bytes`, '');
  }
```
Breaks when: A misbehaving agent sends 4+ MB without a newline. The buffer is cleared before the error is thrown, so the `ProtocolError` carries an empty `line` field. The caller (`AcpClient.#receive`) closes the connection, but the log shows "no line ending after 4194304 bytes: " with no excerpt of what was actually received.
Fix shape: Preserve a prefix of the overflowing buffer in the error (e.g., first 200 chars) before clearing.

### `packages/acp/src/client.ts:494-506` — Gate error caught and converted to "cancelled" without distinction
```
Evidence:
  async #answerPermission(id: RequestId, params: RequestPermissionRequest): Promise<void> {
    let response: RequestPermissionResponse;
    try {
      const optionId = await this.#gate.permission(params);
      response = optionId === null ? cancelledOutcome() : selectedOutcome(optionId);
    } catch (error) {
      this.#reportListenerError(error);
      response = cancelledOutcome();
    }
    this.#write(encodeSuccess(id, response));
  }
```
Breaks when: The `PermissionGate` throws (e.g., `terminal.read()` rejects, or a policy bug). The agent receives `cancelled` — indistinguishable from the user pressing Enter to decline. The human sees "declined" in the transcript but the root cause (a crashed gate) is only in stderr via `#reportListenerError`.
Fix shape: Distinguish gate crashes from user declines — send a distinct error code or include the error message in the response `data` field.

### `app/src/core/run.ts:124-139` — `runTurn` registers `SIGINT` handler but doesn't verify it works on non-TTY
```
Evidence:
  const interrupt = options.onInterrupt;
  if (interrupt) {
    process.once('SIGINT', interrupt);
  }
```
Breaks when: `lotse start` is run with piped stdin (not a TTY). The `processTerminal()` returns `interactive: false`, but `runTurn` still registers the `SIGINT` handler. If the parent shell sends `SIGINT` to the process group, the handler fires and cancels the turn — but the gate would have already declined everything. Worse, if the process is in a pipeline, `SIGINT` behavior is platform-dependent.
Fix shape: Only register `SIGINT` when `terminal.interactive === true`, or document that `onInterrupt` is only called on TTY.

### `app/src/frontends/cli/auth.ts:142-149` — `runInteractively` doesn't distinguish spawn failure from exit code
```
Evidence:
  function runInteractively(command: { program: string; args: string[] }): Promise<number> {
    return new Promise((resolve, reject) => {
      const child = spawn(command.program, command.args, { stdio: 'inherit' });
      child.on('error', reject);
      child.on('exit', (code) => resolve(code ?? 1));
    });
  }
```
Breaks when: The login command (`opencode auth login`) is not found (ENOENT). The `error` event fires with `ENOENT`, the promise rejects, and the caller (`auth.ts:115-120`) catches it as a non-zero exit code. The user sees "login command exited with [Error: spawn ENOENT]" — confusing because it looks like the command ran and failed, not that it doesn't exist.
Fix shape: Check `which(login.program)` before spawning (already done at line 108), or catch `ENOENT` in the spawn error and surface a clearer message.

---

## 3. Duplication / Dead Code

### `app/src/frontends/cli/start.ts:68-77` and `resume.ts:74-83` — Identical gate construction
```
Evidence: (start.ts)
  const gate = {
    permission: denyAll
      ? () => null
      : terminalGate({
          terminal,
          onDecision: (optionId) => {
            err(`  → ${optionId === null ? 'declined' : `granted (${optionId})`}`);
          },
        }),
  };
```
Breaks when: A change to how the gate logs decisions (e.g., adding timestamps) must be made in two places. `cancel.ts:53` also hardcodes `{ permission: () => null }` instead of using the same pattern.
Fix shape: Extract to `core/policy.ts` as `createTerminalGate(terminal, denyAll, onDecision?)`.

### `packages/acp/src/types.ts:61-70` — `AuthCapabilities` and `LogoutCapabilities` unused
```
Evidence:
export interface AuthCapabilities extends Extensible {
  terminal?: boolean;
}
export interface LogoutCapabilities extends Extensible {}
export interface AgentAuthCapabilities extends Extensible {
  logout?: LogoutCapabilities | null;
}
```
Breaks when: These types exist but `LOTSE_CLIENT_CAPABILITIES` in `gate.ts` only sets `auth: { terminal: false }` and never uses `logout`. The schema defines `auth.logout` but kurier never sends or handles it. Not a bug, but dead code that adds cognitive load.
Fix shape: Remove if not planned for Slice 1, or add a comment linking to the slice where they'll be used.

### `app/src/core/transcript.ts:57-61` — Two `session/update` kinds explicitly ignored
```
Evidence:
    case 'available_commands_update':
    case 'config_option_update':
      // Bookkeeping the user did not ask for. The commands are still available from
      // `session/new`'s answer, where the protocol says they belong.
      return [];
```
Breaks when: A future agent sends these updates with meaningful data (e.g., a new command added mid-session). The transcript silently drops them. The comment says "user did not ask for" but the transcript is supposed to be "a record of what happened" (model.ts:34-37).
Fix shape: Either record them as `kind: 'system'` entries, or add a comment explaining why they're explicitly excluded despite the "record everything" principle.

---

## 4. Leaked Abstraction

### `app/src/core/run.ts:62-66` — Auth classification logic lives in app, not in gate
```
Evidence:
  const result = await client.initialize();
  const auth = classifyAuthMethods(client.authMethods);
  if (!auth.none) {
    options.onNotice?.(describeAuth(auth.agent, auth.terminal));
  }
```
Breaks when: `classifyAuthMethods` and `describeAuth` are protocol-knowledge that belongs in `@lotse/acp`. The app should not know that `authMethods` splits into `terminal` vs `agent` kinds — that's the gate's job. The `gate.ts` already exports `classifyAuthMethods`; the app re-imports it.
Fix shape: Move `describeAuth` to `gate.ts` (or a new `auth.ts` in acp), or make `AcpClient.initialize` return the classified auth info.

### `app/src/frontends/cli/auth.ts:79-98` — Auth flow logic duplicates `gate.ts` classification
```
Evidence:
  const auth = classifyAuthMethods(first.client.authMethods);
  if (auth.none) { ... }
  terminalMethodId = auth.terminal[0]?.id ?? null;
  agentMethodId = auth.agent[0]?.id ?? null;
```
Breaks when: The auth flow in `auth.ts` manually iterates `auth.terminal` and `auth.agent` arrays to decide which method to call. This logic is the *policy* for handling auth — it should be in the gate, not the CLI command.
Fix shape: Add an `authenticate` method to `ClientGate` that encapsulates "try terminal first, then agent login command".

---

## 5. ACP Schema Drift Risk — `scripts/check-schema.mjs`

### `scripts/check-schema.mjs:90-117` — Only checks `LOAD_BEARING` interfaces, misses auth and capability shapes
```
Evidence:
const LOAD_BEARING = [
  'InitializeRequest', 'AuthenticateRequest', 'NewSessionRequest', ...
  // Missing: AuthMethodInfo, SessionCapabilities, AgentCapabilities, McpServer
];
```
Breaks when: The schema changes `AuthMethod` to require a `type` field (currently optional in schema, but opencode omits it). The check doesn't validate `AuthMethodInfo` at all — it only checks interfaces the *client sends*. The agent's `authMethods` shape (trap 1) is never verified against the schema.
Fix shape: Add `AuthMethodInfo`, `SessionCapabilities`, `AgentCapabilities`, `McpServer` variants to `LOAD_BEARING`, or add a separate check for agent-to-client shapes.

### `scripts/check-schema.mjs:67-76` — Method name check skips `$/` methods but doesn't verify `session/update` variants
```
Evidence:
for (const [method, info] of schemaMethods) {
  if (method.startsWith('$/')) continue; // `$/cancel_request` is a notification, not in the table
  ...
}
```
Breaks when: The schema adds a new `session/update` variant (e.g., `session/update.new_variant`). The method name check passes because it's not a method — it's a discriminated union value. The `narrow.ts` `SESSION_UPDATE_KINDS` array would be missing it, causing unknown updates to go to wire listeners instead of the typed channel.
Fix shape: Extract `SESSION_UPDATE_KINDS` from the schema's `SessionUpdate` oneOf discriminator and compare against `types.ts`.

### `scripts/check-schema.mjs:173-180` — Notes but doesn't fail on TS-stricter fields
```
Evidence:
for (const field of ts.required) {
  if (field === 'type') continue;
  if (schemaOptional(spec, field)) {
    notes.push(`${name}.${field} is required in TypeScript, optional in the schema`);
  }
}
```
Breaks when: A field is required in TypeScript (e.g., `NewSessionRequest.cwd`) but optional in the schema. The check reports it as a note, not a failure. This means a client that omits the field would be valid per schema but rejected by kurier's types — a client that *accepts* such a request would be more permissive than kurier.
Fix shape: Decide if this is acceptable (it's documented as intentional) or make it a failure. The comment says "some fields are required by kurier's own use" — but that's a client-side requirement, not a wire requirement.

---

## 6. Comments That Lie / Mislead

### `app/src/core/agents/stdio.ts:49-50` — Claims "kurier never parses" stderr, but CLI prints it
```
Evidence:
/** Lines the agent writes to stderr. ACP says stderr is for logs; kurier never parses it. */
onStderr?: (line: string) => void;
```
Breaks when: A reader assumes stderr is completely opaque. In `auth.ts:72-74` and `start.ts:82-84`, stderr lines are prefixed with `[agent] ` and printed to kurier's stderr. "Never parses" is technically true (no JSON parsing), but "never looks at" is false.
Fix shape: Change to "kurier does not parse stderr as protocol messages; it may forward lines for display".

### `packages/acp/src/types.ts:98-109` — `AuthMethodInfo.kind` described as "what kurier reads" but it's a guess
```
Evidence:
/** `terminal` when the agent advertises the tag, `agent` otherwise. A guess, deliberately. */
kind: 'terminal' | 'agent';
```
Breaks when: A future agent sends `type: "terminal"` per schema. The comment says "A guess, deliberately" but the code in `gate.ts:145` treats `kind === 'terminal'` as authoritative: `if (method.kind === 'terminal' || hasArgs(method)) terminal.push(method);`. If the agent *does* send the tag, this works; if it doesn't, `hasArgs` is the fallback. The comment understates that this guess is load-bearing.
Fix shape: Change comment to "Inferred: `terminal` if the agent sends the tag or provides `args`; `agent` otherwise. This classification drives the auth flow."

### `packages/acp/src/client.ts:368-372` — `#send` throws on closed but `#write` catches and closes
```
Evidence:
  #send(line: string): void {
    if (this.#closed) throw new Error('cannot send on a closed ACP connection');
    this.transport.write(line);
  }

  #write(line: string): void {
    if (this.#closed) return;
    try {
      this.transport.write(line);
    } catch (error) {
      this.close(error instanceof Error ? error.message : String(error));
    }
  }
```
Breaks when: `#send` (used for requests) throws synchronously if closed; `#write` (used for responses/notifications) silently returns. The comment doesn't explain this asymmetry. A caller using `#send` gets an exception; a caller using `#write` gets nothing.
Fix shape: Document the difference, or unify behavior (both should probably reject the pending request).

### `packages/acp/src/transport.ts:30-33` — `ClosedTransport` throws on `write` but `onClose` fires asynchronously
```
Evidence:
  write(_data: string): void {
    throw this.reason;
  }
  onClose(listener: CloseListener): void {
    queueMicrotask(() => listener(this.reason));
  }
```
Breaks when: A caller writes to a `ClosedTransport`, gets an exception, but the `onClose` listener hasn't fired yet (it's queued as a microtask). If the caller catches the error and tries to clean up, the close listener runs *after* the catch block.
Fix shape: Document the microtask timing, or make `onClose` synchronous for `ClosedTransport`.

---

## 7. Guardrail Verification

### Guardrail 1: Session is a scope, not a permission — **HOLDS**
- `gate.ts:172-180` `assertScopeIsNotAuthority` throws on `allow`, `allowed`, `permissions`, `grants`, `capabilities`, `policy`
- `model.ts:96` calls it in `newSession()`
- `store.ts:70, 107, 124` calls it on read, create, and update
- No session record field holds permissions

### Guardrail 2: `request_permission` fails closed — **HOLDS**
- `gate.ts:55` `denyAll = () => null`
- `gate.ts:92` `DENY_EVERYTHING = { permission: denyAll }`
- `client.ts:112` `this.#gate = options.gate ?? DENY_EVERYTHING`
- No code path auto-allows

### Guardrail 3: `fs/read_text_file` and `fs/write_text_file` refused — **HOLDS**
- `gate.ts:38-40` `LOTSE_CLIENT_CAPABILITIES.fs = { readTextFile: false, writeTextFile: false }`
- `client.ts:471-477` `#onAgentRequest` responds with `METHOD_NOT_FOUND` + `FileSystemRefusedError` for both

### Guardrail 4: `_meta` passed through, never parsed — **HOLDS**
- `types.ts:42-45` `Extensible` has index signature and `_meta?: Meta`
- `narrow.ts:27-32` `narrowSessionUpdate` returns `null` for unknown `sessionUpdate` kinds
- `client.ts:443-466` `#onNotification` sends unknown updates to wire listeners, not an error
- `client.ts:481-490` Unknown agent methods get `METHOD_NOT_FOUND` (correct JSON-RPC behavior)

### Architectural Rule: `packages/acp` no `node:child_process`, `gi://`, etc. — **HOLDS**
- Verified all imports in `packages/acp/src/*.ts` — only internal and `@lotse/acp` imports
- `transport.ts` defines `Transport` interface and `channelTransport` adapter
- Actual subprocess code is in `app/src/core/agents/stdio.ts` which imports `node:child_process`

---

## 8. Unverified Items (Need More Context)

### `app/src/frontends/cli/start.ts:128-131` — Ctrl-C handling
```
Evidence:
  onInterrupt: () => {
    err('\n  cancelling — the agent will stop and report `cancelled`');
    handle.client.cancel({ sessionId: created.id });
  },
```
Unverified: If the user presses Ctrl-C *during* the `initialize` handshake (before the session is created), the `SIGINT` handler isn't registered yet (it's registered in `runTurn`). The process would die with `SIGINT` default behavior, leaving the agent subprocess orphaned. The `openAgent` try/catch closes the client on error, but a raw `SIGINT` isn't an error.

### `packages/acp/src/client.ts:539-550` — `#failAll` wraps every rejection with method name
```
Evidence:
  pending.reject(new Error(`${pending.method} did not finish: ${reason.message}`, { cause: reason }));
```
Unverified: The error message includes the method name, which is excellent. But if `reason` is a `ProtocolError` from a parse failure, the cause chain might be deep. No test visible for this path.

### `scripts/check-schema.mjs` — Whether it runs in CI
Unverified: The script exists and is documented in AGENTS.md, but no `.github/workflows` visible in the kurier submodule. Need to check if the parent werkstatt CI runs it.

---

## Summary

| Category | Count |
|----------|-------|
| Correctness bugs | 3 |
| Error paths worse than they look | 4 |
| Duplication / dead code | 3 |
| Leaked abstraction | 2 |
| Schema drift risk | 3 |
| Comments that lie | 4 |
| Guardrails verified | 4/4 hold |
| Architectural rule | Holds |
| Unverified | 3 |

**Top 3 priority fixes:**
1. `StdioChannel.send` backpressure handling (data loss under load)
2. Stderr buffer flush on exit (lost crash diagnostics)
3. `resume.ts` transcript append duplication (drift risk)

**Schema check gap:** The `check-schema.mjs` validates what the *client sends* but not what the *agent sends* — particularly `authMethods` shape (trap 1) and `session/update` variants (extensibility). This is the most likely source of silent drift against real agents.