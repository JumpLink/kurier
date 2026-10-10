/**
 * The login dialog's logic, with no widget in it.
 *
 * A window cannot print a URL and wait on stdin the way `lotse login` does, so this holds the same
 * steps as a state a dialog can draw: the providers on offer, the fields a method still asks for, the
 * URL and code to show, the pasted code to collect, and the end. The dialog only renders `state` and
 * calls the methods below; every decision lives here, where a test can drive it without a display.
 *
 * It owns one private server for the lifetime of the dialog (`open` starts it, `close` stops it) and
 * stores nothing: the credential lands in the agent's own store, exactly as with the CLI. What the
 * window does *after* `connected` — restart the agent so it reads the new credential — is the caller's,
 * through `onConnected`.
 */

import {
  answersFor,
  runLogin,
  type LoginApi,
  type LoginHooks,
  type LoginPrompt,
  type LoginResult,
} from './flow.ts';
import type { LoginField, LoginMethod, LoginProvider } from './providers.ts';

/** What the controller needs from the private server. `createLoginApi` + `startServer` are the real one. */
export interface LoginSession extends LoginApi {
  providers(): Promise<LoginProvider[]>;
  connectKey(providerId: string, key: string, answer: Readonly<Record<string, string>>): Promise<void>;
  close(): Promise<void>;
}

export type LoginState =
  | { readonly step: 'starting' }
  /** No login server can be had here; `reason` is a sentence for the person (a terminal hint, usually). */
  | { readonly step: 'unavailable'; readonly reason: string }
  | { readonly step: 'providers'; readonly providers: readonly LoginProvider[] }
  /** One provider with more than one way in. */
  | { readonly step: 'methods'; readonly provider: LoginProvider }
  /** A method that still needs answers; `values` is what has been given so far. */
  | {
      readonly step: 'fields';
      readonly provider: LoginProvider;
      readonly method: LoginMethod;
      readonly missing: readonly LoginField[];
    }
  /** An API key method with every question answered: the person pastes the key. */
  | { readonly step: 'key'; readonly provider: LoginProvider; readonly method: LoginMethod }
  /** The provider is being asked to begin. */
  | { readonly step: 'beginning'; readonly provider: LoginProvider }
  /** `prompt.mode` says whether lotse polls (`auto`) or the person pastes a code (`code`). */
  | { readonly step: 'waiting'; readonly provider: LoginProvider; readonly prompt: LoginPrompt }
  | { readonly step: 'connected'; readonly provider: LoginProvider }
  | { readonly step: 'failed'; readonly message: string }
  | { readonly step: 'expired' }
  | { readonly step: 'closed' };

export interface LoginControllerDeps {
  /** Start the server and wrap it; rejects with the reason when it cannot be done. */
  openSession(): Promise<LoginSession>;
  /** Why this agent has no login server, or `null`. Asked before anything is started. */
  unavailableReason(): string | null;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Called once per successful login, before the state becomes `connected`. */
  onConnected?(provider: LoginProvider): void | Promise<void>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class LoginController {
  readonly #deps: LoginControllerDeps;
  readonly #listeners = new Set<(state: LoginState) => void>();
  #state: LoginState = { step: 'starting' };
  #session: LoginSession | null = null;
  #closed = false;
  #opening = false;
  #cancelled = false;
  #pendingCode: ((code: string | null) => void) | null = null;
  /** Answers collected so far for the method in `fields`. */
  #given: Record<string, string> = {};
  /** The form answers of the key method in `key`, sent with the key. */
  #keyAnswer: Record<string, string> = {};

  constructor(deps: LoginControllerDeps) {
    this.#deps = deps;
  }

  get state(): LoginState {
    return this.#state;
  }

  subscribe(listener: (state: LoginState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #set(state: LoginState): void {
    if (this.#closed && state.step !== 'closed') return;
    this.#state = state;
    for (const listener of this.#listeners) listener(state);
  }

  /** Start the server and show the providers. */
  async open(): Promise<void> {
    if (this.#session || this.#opening) return;
    this.#opening = true;
    try {
      await this.#open();
    } finally {
      this.#opening = false;
    }
  }

  async #open(): Promise<void> {
    const reason = this.#deps.unavailableReason();
    if (reason) {
      this.#set({ step: 'unavailable', reason });
      return;
    }
    this.#set({ step: 'starting' });
    let session: LoginSession;
    try {
      session = await this.#deps.openSession();
    } catch (error) {
      this.#set({ step: 'failed', message: `could not start the login server: ${messageOf(error)}` });
      return;
    }
    if (this.#closed) {
      await session.close();
      return;
    }
    this.#session = session;
    try {
      this.#set({ step: 'providers', providers: await session.providers() });
    } catch (error) {
      this.#set({ step: 'failed', message: `could not read the provider list: ${messageOf(error)}` });
    }
  }

  /** Pick a provider: straight into its only method, or to the choice between several. */
  pickProvider(provider: LoginProvider): Promise<void> | void {
    if (provider.methods.length === 1) return this.pickMethod(provider, provider.methods[0]!);
    this.#set({ step: 'methods', provider });
  }

  /** Pick a method: ask for what it needs, or begin. */
  pickMethod(provider: LoginProvider, method: LoginMethod): Promise<void> | void {
    this.#given = {};
    this.#keyAnswer = {};
    return this.submitFields(provider, method, {});
  }

  /** Add answers and begin once nothing required is missing. */
  async submitFields(
    provider: LoginProvider,
    method: LoginMethod,
    values: Readonly<Record<string, string>>,
  ): Promise<void> {
    Object.assign(this.#given, values);
    const { answer, missing } = answersFor(method, this.#given);
    if (missing.length > 0) {
      this.#set({ step: 'fields', provider, method, missing });
      return;
    }
    if (method.kind === 'key') {
      this.#keyAnswer = answer;
      this.#set({ step: 'key', provider, method });
      return;
    }
    await this.#begin(provider, method, answer);
  }

  /**
   * Hand a pasted API key to opencode. The key is held in this call and nowhere else: not in `state`, not in
   * a field, and not in a message — a failure says what the server answered, never what was sent.
   */
  async submitKey(provider: LoginProvider, key: string): Promise<void> {
    const session = this.#session;
    const trimmed = key.trim();
    // Only from the key step: a second submit while the first is in flight would store and restart twice.
    if (!session || this.#state.step !== 'key' || trimmed === '') return;
    this.#set({ step: 'beginning', provider });
    try {
      await session.connectKey(provider.id, trimmed, this.#keyAnswer);
    } catch (error) {
      // A server may echo what it was sent; the key is never in a message.
      this.#set({ step: 'failed', message: messageOf(error).split(trimmed).join('[key]') });
      return;
    }
    this.#keyAnswer = {};
    await this.#connected(provider);
  }

  async #connected(provider: LoginProvider): Promise<void> {
    try {
      await this.#deps.onConnected?.(provider);
    } catch (error) {
      // The login itself worked; only the follow-up did not. Say so instead of calling it a failure.
      this.#set({
        step: 'failed',
        message: `logged in, but the agent could not be restarted: ${messageOf(error)}`,
      });
      return;
    }
    this.#set({ step: 'connected', provider });
  }

  async #begin(provider: LoginProvider, method: LoginMethod, answer: Record<string, string>): Promise<void> {
    const session = this.#session;
    if (!session) return;
    this.#cancelled = false;
    this.#set({ step: 'beginning', provider });
    const hooks: LoginHooks = {
      show: (prompt) => this.#set({ step: 'waiting', provider, prompt }),
      askCode: () =>
        new Promise((resolve) => {
          this.#pendingCode = resolve;
        }),
      sleep: (ms) => this.#deps.sleep(ms),
      now: () => this.#deps.now(),
      isCancelled: () => this.#cancelled || this.#closed,
    };
    let result: LoginResult;
    try {
      result = await runLogin(session, provider.id, method.id, answer, hooks);
    } catch (error) {
      this.#set({ step: 'failed', message: messageOf(error) });
      return;
    } finally {
      this.#pendingCode = null;
    }
    switch (result.kind) {
      case 'connected':
        await this.#connected(provider);
        return;
      case 'failed':
        this.#set({ step: 'failed', message: result.message });
        return;
      case 'expired':
        this.#set({ step: 'expired' });
        return;
      case 'cancelled':
        // Cancelling goes back to the choice; a closed dialog stays closed (`#set` drops the update).
        void this.showProviders();
    }
  }

  /** Back to the list, on the server that is already up. */
  async showProviders(): Promise<void> {
    const session = this.#session;
    if (!session) return;
    try {
      this.#set({ step: 'providers', providers: await session.providers() });
    } catch (error) {
      this.#set({ step: 'failed', message: `could not read the provider list: ${messageOf(error)}` });
    }
  }

  /** `code` mode: hand over what the person pasted. Blank input is ignored, the attempt stays open. */
  submitCode(code: string): void {
    if (code.trim() === '') return;
    this.#pendingCode?.(code.trim());
    this.#pendingCode = null;
  }

  /** Abandon the running attempt. Safe at any step. */
  cancel(): void {
    this.#cancelled = true;
    this.#pendingCode?.(null);
    this.#pendingCode = null;
  }

  /** Stop everything. The dialog calls this when it goes away; safe to call twice. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.cancel();
    this.#closed = true;
    const session = this.#session;
    this.#session = null;
    this.#set({ step: 'closed' });
    await session?.close();
  }
}
