/**
 * One OAuth login, as a function of an API and a few hooks — and nothing else.
 *
 * **What lotse does here and what it never does.** opencode starts the flow and finishes it: it holds the
 * device code, talks to the provider and writes the credential into its own store. lotse's part is to
 * *show* the person a URL and a code, to hand a pasted code back when the provider wants one, and to ask
 * whether it is done yet. No token, key or code ever lives longer here than the call that carries it, and
 * nothing is written to disk — which is why this module is allowed to exist next to § Privacy.
 *
 * Both runtimes and every surface use this one function: the CLI prints the prompt, the window shows a
 * dialog, and the tests drive it with a scripted API and a fake clock. `LoginHooks` is the whole surface
 * contract, and it has no widget in it.
 *
 * **Two modes, because the provider decides.** `auto` — the person approves in a browser and the status
 * flips by itself; lotse polls. `code` — the provider shows a code in the browser that has to be pasted
 * back, and `askCode` is where a surface collects it.
 */

import type { LoginField, LoginMethod } from './providers.ts';

export type LoginMode = 'auto' | 'code';

export interface OAuthAttempt {
  readonly attemptId: string;
  readonly url: string;
  readonly instructions: string;
  readonly mode: LoginMode;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
}

export type OAuthStatus =
  | { readonly status: 'pending' }
  | { readonly status: 'complete' }
  | { readonly status: 'failed'; readonly message: string }
  | { readonly status: 'expired' };

/** What a login needs from opencode. `createLoginApi` (`api.ts`) is the real one; tests script their own. */
export interface LoginApi {
  begin(
    providerId: string,
    methodId: string,
    answer: Readonly<Record<string, string>>,
  ): Promise<OAuthAttempt>;
  status(providerId: string, attemptId: string): Promise<OAuthStatus>;
  complete(providerId: string, attemptId: string, code: string): Promise<void>;
  cancel(providerId: string, attemptId: string): Promise<void>;
}

export interface LoginPrompt {
  readonly url: string;
  readonly instructions: string;
  readonly mode: LoginMode;
  readonly expiresAt: number;
}

export interface LoginHooks {
  /** Put the URL and the instructions in front of the person. Called once per attempt. */
  show(prompt: LoginPrompt): void;
  /** `code` mode only: collect the pasted code. `null` is "never mind" and cancels the attempt. */
  askCode(): Promise<string | null>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Read between polls: a closed dialog or a Ctrl-C turns into a cancelled attempt, not a dangling one. */
  isCancelled(): boolean;
}

export type LoginResult =
  | { readonly kind: 'connected' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'expired' }
  | { readonly kind: 'cancelled' };

export const POLL_MS = 2000;
/** Consecutive status calls that may fail before the attempt is given up as failed. */
export const MAX_POLL_FAILURES = 3;
/** How long past the announced expiry lotse keeps asking before it stops waiting on its own clock. */
export const EXPIRY_GRACE_MS = 15_000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isActive(field: LoginField, values: Readonly<Record<string, string>>): boolean {
  return (field.when ?? []).every((condition) => values[condition.key] === condition.value);
}

/**
 * The answers to send, and the fields still unanswered.
 *
 * Defaults fill a field nobody was asked (a hidden one, or a default the person left alone); a field whose
 * `when` is not met is skipped and sends nothing. `missing` is what a surface still has to ask for, in the
 * order opencode listed it — a later field's `when` is read against the answers of the earlier ones.
 */
export function answersFor(
  method: Pick<LoginMethod, 'fields'>,
  given: Readonly<Record<string, string>>,
): { answer: Record<string, string>; missing: LoginField[] } {
  const answer: Record<string, string> = {};
  const missing: LoginField[] = [];
  for (const field of method.fields) {
    if (!isActive(field, answer)) continue;
    const value = given[field.key] ?? field.default;
    if (value === undefined || value === '') {
      if (field.required) missing.push(field);
      continue;
    }
    answer[field.key] = value;
  }
  return { answer, missing };
}

/** Run one login to its end. Never throws for an outcome — only a failed `begin` rejects. */
export async function runLogin(
  api: LoginApi,
  providerId: string,
  methodId: string,
  answer: Readonly<Record<string, string>>,
  hooks: LoginHooks,
): Promise<LoginResult> {
  const attempt = await api.begin(providerId, methodId, answer);
  hooks.show({
    url: attempt.url,
    instructions: attempt.instructions,
    mode: attempt.mode,
    expiresAt: attempt.expiresAt,
  });

  const cancel = async (): Promise<LoginResult> => {
    // Best effort: the attempt may already be gone, and the outcome is the same either way.
    await api.cancel(providerId, attempt.attemptId).catch(() => undefined);
    return { kind: 'cancelled' };
  };

  if (attempt.mode === 'code') {
    const code = (await hooks.askCode())?.trim();
    if (!code) return cancel();
    try {
      await api.complete(providerId, attempt.attemptId, code);
    } catch (error) {
      return { kind: 'failed', message: messageOf(error) };
    }
  }

  let failures = 0;
  for (;;) {
    if (hooks.isCancelled()) return cancel();
    if (hooks.now() > attempt.expiresAt + EXPIRY_GRACE_MS) {
      await api.cancel(providerId, attempt.attemptId).catch(() => undefined);
      return { kind: 'expired' };
    }
    let status: OAuthStatus;
    try {
      status = await api.status(providerId, attempt.attemptId);
      failures = 0;
    } catch (error) {
      failures += 1;
      if (failures >= MAX_POLL_FAILURES) return { kind: 'failed', message: messageOf(error) };
      await hooks.sleep(POLL_MS);
      continue;
    }
    switch (status.status) {
      case 'complete':
        return { kind: 'connected' };
      case 'failed':
        return { kind: 'failed', message: status.message };
      case 'expired':
        return { kind: 'expired' };
      case 'pending':
        await hooks.sleep(POLL_MS);
    }
  }
}
