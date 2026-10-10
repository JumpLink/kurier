/**
 * opencode v2's integration API, as far as a login needs it — over an injected `send`.
 *
 * **The transport is a parameter, so this file never opens a socket.** `core/agents/server.ts` supplies a
 * `send` that talks to a real `opencode serve`; a test supplies one that records what was asked. The paths
 * and bodies below were measured against opencode 2.0.22 (its `/openapi.json`, and one live
 * `connect/oauth` call that answered `{attemptID, url, instructions, mode: "auto", time}`):
 *
 * - `GET  /api/integration` — the catalog.
 * - `POST /api/integration/{id}/connect/oauth` `{methodID, answer?}` — begin; the answer carries the fields.
 * - `GET  /api/integration/{id}/connect/oauth/{attempt}` — `pending` | `complete` | `failed{message}` | `expired`.
 * - `POST …/complete` `{code}` — for `code` mode.
 * - `DELETE …/{attempt}` — cancel.
 * - `POST /api/integration/{id}/connect/key` `{key, answer?}` — an API key; answers 204 with no body.
 *
 * v1 has none of this (it has `/provider/auth`), which is why a 404 on the catalog is its own error: it
 * means "this opencode cannot be logged in to from here", not "something broke".
 */

import type { LoginApi, OAuthAttempt, OAuthStatus } from './flow.ts';
import { parseIntegrations, type LoginPolicy, type LoginProvider } from './providers.ts';

export interface HttpResponse {
  readonly status: number;
  /** The parsed body, or `null` when there was none. */
  readonly json: unknown;
}

export type Send = (method: string, path: string, body?: unknown) => Promise<HttpResponse>;

export class LoginApiError extends Error {
  constructor(
    readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = 'LoginApiError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeFailure(response: HttpResponse): string {
  const message = isRecord(response.json) ? response.json['message'] : undefined;
  return typeof message === 'string' && message ? message : `HTTP ${response.status}`;
}

function data(response: HttpResponse, what: string): Record<string, unknown> {
  const body = isRecord(response.json) ? response.json['data'] : undefined;
  if (!isRecord(body))
    throw new LoginApiError(response.status, `${what}: the response has no \`data\` object`);
  return body;
}

function ok(response: HttpResponse): HttpResponse {
  if (response.status < 200 || response.status >= 300) {
    throw new LoginApiError(response.status, describeFailure(response));
  }
  return response;
}

function parseAttempt(response: HttpResponse): OAuthAttempt {
  const body = data(ok(response), 'begin');
  const time = isRecord(body['time']) ? body['time'] : {};
  const { attemptID, url, instructions, mode } = body;
  const expires = time['expires'];
  if (typeof attemptID !== 'string' || typeof url !== 'string') {
    throw new LoginApiError(response.status, 'begin: the response names no attempt or no URL');
  }
  if (mode !== 'auto' && mode !== 'code') {
    throw new LoginApiError(response.status, `begin: unknown mode ${JSON.stringify(mode)}`);
  }
  return {
    attemptId: attemptID,
    url,
    instructions: typeof instructions === 'string' ? instructions : '',
    mode,
    // A missing or non-numeric expiry falls back to ten minutes, the lifetime measured on 2.0.22.
    expiresAt: typeof expires === 'number' ? expires : Date.now() + 10 * 60_000,
  };
}

function parseStatus(response: HttpResponse): OAuthStatus {
  const body = data(ok(response), 'status');
  switch (body['status']) {
    case 'pending':
    case 'complete':
    case 'expired':
      return { status: body['status'] };
    case 'failed':
      return {
        status: 'failed',
        message:
          typeof body['message'] === 'string' && body['message'] ? body['message'] : 'the login failed',
      };
    default:
      throw new LoginApiError(response.status, `status: unknown value ${JSON.stringify(body['status'])}`);
  }
}

export interface OpencodeLogin extends LoginApi {
  /** Hand opencode an API key, which it stores. lotse keeps it only for the length of this call. */
  connectKey(providerId: string, key: string, answer: Readonly<Record<string, string>>): Promise<void>;
  /** The providers to offer. Rejects with a 404 `LoginApiError` for an opencode that has no such API. */
  providers(policy?: LoginPolicy): Promise<LoginProvider[]>;
}

export function createLoginApi(send: Send): OpencodeLogin {
  const base = (providerId: string): string =>
    `/api/integration/${encodeURIComponent(providerId)}/connect/oauth`;
  return {
    async providers(policy) {
      const response = await send('GET', '/api/integration');
      if (response.status === 404) throw new LoginApiError(404, 'this opencode has no integration API');
      return parseIntegrations(ok(response).json, policy);
    },
    async connectKey(providerId, key, answer) {
      const body = Object.keys(answer).length > 0 ? { key, answer } : { key };
      ok(await send('POST', `/api/integration/${encodeURIComponent(providerId)}/connect/key`, body));
    },
    async begin(providerId, methodId, answer) {
      const body = Object.keys(answer).length > 0 ? { methodID: methodId, answer } : { methodID: methodId };
      return parseAttempt(await send('POST', base(providerId), body));
    },
    async status(providerId, attemptId) {
      return parseStatus(await send('GET', `${base(providerId)}/${encodeURIComponent(attemptId)}`));
    },
    async complete(providerId, attemptId, code) {
      ok(await send('POST', `${base(providerId)}/${encodeURIComponent(attemptId)}/complete`, { code }));
    },
    async cancel(providerId, attemptId) {
      const response = await send('DELETE', `${base(providerId)}/${encodeURIComponent(attemptId)}`);
      // Gone already is as good as cancelled.
      if (response.status !== 404) ok(response);
    },
  };
}
