/** opencode's integration API, over a `send` that records what it was asked. Bodies are the measured shapes. */

import { describe, expect, it } from '@gjsify/unit';

import { createLoginApi, type HttpResponse, type LoginApiError, type Send } from '@kurier/core';

function recorder(...responses: HttpResponse[]) {
  const requests: string[] = [];
  let at = 0;
  const send: Send = async (method, path, body) => {
    requests.push(`${method} ${path}${body === undefined ? '' : ` ${JSON.stringify(body)}`}`);
    return responses[Math.min(at++, responses.length - 1)]!;
  };
  return { send, requests };
}

const BEGUN = {
  status: 200,
  json: {
    location: { directory: '/synthetic' },
    data: {
      attemptID: 'con_synthetic',
      url: 'https://login.example/device',
      instructions: 'Enter code: AAAA-BBBB',
      mode: 'auto',
      time: { created: 1_000, expires: 601_000 },
    },
  },
};

const status = (value: Record<string, unknown>): HttpResponse => ({
  status: 200,
  json: { location: { directory: '/synthetic' }, data: { ...value, time: { created: 1, expires: 2 } } },
});

async function rejection(promise: Promise<unknown>): Promise<LoginApiError> {
  try {
    await promise;
  } catch (error) {
    return error as LoginApiError;
  }
  throw new Error('expected a rejection');
}

export default async () => {
  await describe('createLoginApi', async () => {
    await it('begins at the integration, with the method id and only the answers there are', async () => {
      const r = recorder(BEGUN);
      const attempt = await createLoginApi(r.send).begin('openai', 'chatgpt-headless', {});
      expect(r.requests[0]).toBe(
        'POST /api/integration/openai/connect/oauth {"methodID":"chatgpt-headless"}',
      );
      expect(attempt.attemptId).toBe('con_synthetic');
      expect(attempt.url).toBe('https://login.example/device');
      expect(attempt.instructions).toBe('Enter code: AAAA-BBBB');
      expect(attempt.mode).toBe('auto');
      expect(attempt.expiresAt).toBe(601_000);

      const r2 = recorder(BEGUN);
      await createLoginApi(r2.send).begin('gitlab', 'pkce', { instanceUrl: 'https://git.example' });
      expect(r2.requests[0]).toBe(
        'POST /api/integration/gitlab/connect/oauth {"methodID":"pkce","answer":{"instanceUrl":"https://git.example"}}',
      );
    });

    await it('escapes ids that would change the path', async () => {
      const r = recorder(BEGUN);
      await createLoginApi(r.send).begin('a/b', 'm', {});
      expect(r.requests[0]!.startsWith('POST /api/integration/a%2Fb/connect/oauth ')).toBe(true);
    });

    await it('reads the four statuses', async () => {
      const api = createLoginApi(
        recorder(
          status({ status: 'pending' }),
          status({ status: 'complete' }),
          status({ status: 'failed', message: 'denied' }),
          status({ status: 'expired' }),
        ).send,
      );
      const seen = [];
      for (let i = 0; i < 4; i += 1) seen.push(await api.status('p', 'a'));
      expect(JSON.stringify(seen)).toBe(
        '[{"status":"pending"},{"status":"complete"},{"status":"failed","message":"denied"},{"status":"expired"}]',
      );
    });

    await it('refuses a status it does not know rather than guessing', async () => {
      const error = await rejection(
        createLoginApi(recorder(status({ status: 'weird' })).send).status('p', 'a'),
      );
      expect(error.message.includes('unknown value')).toBe(true);
    });

    await it('refuses a mode it does not know', async () => {
      const odd = { status: 200, json: { data: { ...(BEGUN.json.data as object), mode: 'qr' } } };
      const error = await rejection(createLoginApi(recorder(odd).send).begin('p', 'm', {}));
      expect(error.message.includes('unknown mode')).toBe(true);
    });

    await it('completes with the code and cancels with a DELETE; a cancel that finds nothing is fine', async () => {
      const r = recorder({ status: 200, json: null }, { status: 404, json: { message: 'gone' } });
      const api = createLoginApi(r.send);
      await api.complete('openai', 'att', '1234');
      await api.cancel('openai', 'att');
      expect(r.requests.join('\n')).toBe(
        'POST /api/integration/openai/connect/oauth/att/complete {"code":"1234"}\nDELETE /api/integration/openai/connect/oauth/att',
      );
    });

    await it("carries the server's message on an error status", async () => {
      const error = await rejection(
        createLoginApi(recorder({ status: 500, json: { message: 'OAuth method not found' } }).send).begin(
          'p',
          'm',
          {},
        ),
      );
      expect(error.httpStatus).toBe(500);
      expect(error.message).toBe('OAuth method not found');
    });

    await it('says "no integration API" for a 404 on the catalog, which is what v1 answers', async () => {
      const error = await rejection(createLoginApi(recorder({ status: 404, json: null }).send).providers());
      expect(error.httpStatus).toBe(404);
      expect(error.message.includes('no integration API')).toBe(true);
    });

    await it('parses the catalog through the provider policy', async () => {
      const catalog = {
        status: 200,
        json: {
          data: [
            { id: 'xai', name: 'xAI', methods: [{ type: 'oauth', id: 'device', label: 'SuperGrok' }] },
            { id: 'poe', name: 'Poe', methods: [{ type: 'oauth', id: 'browser', label: 'Poe' }] },
          ],
        },
      };
      const providers = await createLoginApi(recorder(catalog).send).providers();
      expect(providers.map((p) => p.id).join(',')).toBe('poe');
    });

    await it('sends an API key to connect/key and accepts the empty 204', async () => {
      const r = recorder({ status: 204, json: null });
      await createLoginApi(r.send).connectKey('scaleway', 'sk-synthetic', {});
      expect(r.requests.join('\n')).toBe('POST /api/integration/scaleway/connect/key {"key":"sk-synthetic"}');
    });

    await it('sends the form answers with the key, and rejects a 400 without echoing the key', async () => {
      const r = recorder({ status: 400, json: { message: 'bad request' } });
      let message = '';
      try {
        await createLoginApi(r.send).connectKey('azure', 'sk-synthetic', { resource: 'r' });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(r.requests[0]).toBe(
        'POST /api/integration/azure/connect/key {"key":"sk-synthetic","answer":{"resource":"r"}}',
      );
      expect(message).toBe('bad request');
    });
  });
};
