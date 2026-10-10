/**
 * Which page a chat shows when the agent is found but may have no provider behind it. Pure.
 *
 * **Measured, not assumed** (`scripts/probes/provider-connections.mjs`, opencode 2.0.25, scratch HOME):
 * `GET /api/integration` reports `connections` per provider — empty in a fresh home, one entry (a
 * credential id, no secret) after a key was connected. ACP itself reports nothing of the kind: its
 * `authMethods` is the single terminal method and `session/new` succeeds with no login. So the
 * connection state comes from the same private `opencode serve` the login dialog already uses
 * (`probeConnections`), and the free hosted models work with **no** connection — which is why this is
 * an offer and never a wall: the person can always continue.
 *
 * **Fail-closed means "say nothing we do not know".** An unreadable catalog, a login server that cannot
 * be started or an agent that has no login API is `unknown`, and `unknown` shows the ordinary chat,
 * exactly as before; a turn that then fails on a login still earns the existing auth dialog with its
 * **Log in…** button. Nothing here reads, keeps or logs a credential: it counts providers.
 */

import type { LoginProvider } from './login/providers.ts';

/** What is known about the agent's providers. */
export type ConnectionFacts =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'connected' }
  /** `browser` and `key` count the providers offering each way in, from the same catalog. */
  | { readonly kind: 'none'; readonly browser: number; readonly key: number };

/** Read the catalog's connection state. An empty catalog tells nothing, so it is `unknown`. */
export function connectionFacts(providers: readonly LoginProvider[]): ConnectionFacts {
  if (providers.length === 0) return { kind: 'unknown' };
  if (providers.some((provider) => provider.connected)) return { kind: 'connected' };
  const offering = (kind: 'oauth' | 'key') =>
    providers.filter((provider) => provider.methods.some((method) => method.kind === kind)).length;
  return { kind: 'none', browser: offering('oauth'), key: offering('key') };
}

export interface OnboardingInput {
  /** The host asked for onboarding at all. */
  readonly enabled: boolean;
  /** No agent could be resolved: the no-agent page wins. */
  readonly noAgent: boolean;
  /** A login can be run from here (`loginUnavailableReason(agent) === null`). */
  readonly loginAvailable: boolean;
  readonly connection: ConnectionFacts;
  /** The person chose to continue with the free models. */
  readonly dismissed: boolean;
}

export interface OnboardingPath {
  readonly label: string;
  readonly detail: string;
}

export interface OnboardingView {
  readonly title: string;
  readonly body: string;
  /** The ways in the login dialog offers, with how many providers each reaches. */
  readonly paths: readonly OnboardingPath[];
  /** The primary button: opens the login dialog. */
  readonly connect: string;
  /** The secondary button: carry on without a provider. Says what the free models are. */
  readonly free: string;
  readonly freeNote: string;
}

const count = (n: number): string => `${n} provider${n === 1 ? '' : 's'}`;

/** The onboarding page, or `null` when the ordinary chat page is the right one. */
export function onboardingView(input: OnboardingInput): OnboardingView | null {
  if (!input.enabled || input.noAgent || input.dismissed || !input.loginAvailable) return null;
  if (input.connection.kind !== 'none') return null;
  const { browser, key } = input.connection;
  const paths: OnboardingPath[] = [];
  if (browser > 0) paths.push({ label: 'Browser login', detail: count(browser) });
  if (key > 0) paths.push({ label: 'API key', detail: count(key) });
  return {
    title: 'Connect a provider',
    body: 'No provider is connected to this agent yet. Connect one to use your own models.',
    paths,
    connect: 'Connect a provider…',
    free: 'Use free hosted models',
    freeNote:
      'Free hosted models need no account. They are time-limited, and what you send goes to the provider that hosts them.',
  };
}
