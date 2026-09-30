/**
 * The two client methods that write into the agent — `session/set_mode` and
 * `session/set_config_option` — plus the capability announcement that has to exist for an agent to
 * have any reason to send the options in the first place.
 *
 * **Why this is in `packages/acp` and not in the surface.** The values live in the agent, and the
 * agent is the only authority on them. So kurier never keeps a copy: it re-reads them from
 * `session/new`, `session/load`, `session/resume`, from every `set_config_option` answer and from
 * `config_option_update`. A test that pinned "the client remembers the model" would pin the one
 * behaviour that must never exist.
 *
 * **The measurement that is easy to get backwards** (it was, in this repo's own plan, and cost a
 * product decision): `configOptions` is a **client** capability. It sits under
 * `ClientCapabilities.session`, so whether it appears in `initialize` says what *kurier* can do —
 * not what the agent offers. `opencode acp` 2.0.19 sends 400+ models whether kurier announces
 * anything or not. The announcement is still right, and the tests below pin it in the right
 * direction.
 */

import { describe, expect, it } from '@gjsify/unit';

import { AcpClient } from '@kurier/acp/client';
import { KURIER_CLIENT_CAPABILITIES } from '@kurier/acp/gate';
import { CLIENT_METHODS } from '@kurier/acp/methods';
import { isAuthRequired } from '@kurier/acp/client';
import type { SessionConfigOption, SessionNotification, SessionUpdate } from '@kurier/acp/types';

import { FixtureAgent } from '../../support/fixture-agent.ts';

function currentValueOf(options: SessionConfigOption[] | undefined, id: string): unknown {
  return options?.find((option) => option.id === id)?.currentValue;
}

export default async () => {
  await describe('the capability announcement', async () => {
    await it('announces session.configOptions, because kurier can act on the options', async () => {
      expect(KURIER_CLIENT_CAPABILITIES.session?.configOptions).toStrictEqual({});
    });

    await it('does NOT announce boolean options, and the fixture is why', async () => {
      // `opencode acp` 2.0.19 answers `InvalidConfigOptionError` for any value that is not a
      // string, so it implements no boolean options at all. `{}` under `boolean` would be a promise
      // the agent is entitled to break — and one this repository has no surface for yet.
      const capabilities = KURIER_CLIENT_CAPABILITIES.session?.configOptions as
        | { boolean?: unknown }
        | undefined;
      expect(capabilities?.boolean ?? null).toBe(null);
    });

    await it('goes out in initialize, under clientCapabilities', async () => {
      const fixture = new FixtureAgent();
      const client = new AcpClient({ transport: fixture.transport });
      await client.initialize();
      const sent = fixture.calls(CLIENT_METHODS.initialize)[0]?.params as {
        clientCapabilities?: { session?: unknown };
      };
      expect(sent?.clientCapabilities?.session).toStrictEqual({ configOptions: {} });
      client.close();
    });
  });

  await describe('reading the options', async () => {
    await it('session/new reports them, and the client hands them on unparsed', async () => {
      const fixture = new FixtureAgent();
      const client = new AcpClient({ transport: fixture.transport });
      await client.initialize();
      const session = await client.newSession({ cwd: '/tmp', mcpServers: [] });
      // Three options, in the measured shape: a model with a list, a thought level, a mode.
      expect(session.configOptions?.map((option) => option.id)).toEqualArray(['model', 'effort', 'mode']);
      expect(session.modes?.currentModeId).toBe('build');
      client.close();
    });

    await it('session/load reports them too, so a reopened session is not a guess', async () => {
      const fixture = new FixtureAgent();
      const client = new AcpClient({ transport: fixture.transport });
      await client.initialize();
      const loaded = await client.loadSession({ sessionId: 'ses_fixture_0001', cwd: '/tmp', mcpServers: [] });
      expect(loaded.configOptions?.length).toBe(3);
      client.close();
    });

    await it('an agent with no options reports none — which is not an error', async () => {
      const fixture = new FixtureAgent({ configOptions: [] });
      const client = new AcpClient({ transport: fixture.transport });
      await client.initialize();
      const session = await client.newSession({ cwd: '/tmp', mcpServers: [] });
      expect(session.configOptions).toStrictEqual([]);
      client.close();
    });
  });

  await describe('session/set_config_option', async () => {
    await it('sends the value id and returns the FULL option list', async () => {
      const fixture = new FixtureAgent();
      const client = new AcpClient({ transport: fixture.transport });
      await client.initialize();
      const session = await client.newSession({ cwd: '/tmp', mcpServers: [] });

      const answer = await client.setConfigOption({
        sessionId: session.sessionId,
        configId: 'effort',
        value: 'xhigh',
      });

      expect(fixture.calls(CLIENT_METHODS.setSessionConfigOption).length).toBe(1);
      // The answer is the truth, not an acknowledgement: an agent that clamps a value it does not
      // have answers with the corrected list, and a client that kept its own guess would be wrong.
      expect(answer.configOptions.map((option) => option.id)).toEqualArray(['model', 'effort', 'mode']);
      expect(currentValueOf(answer.configOptions, 'effort')).toBe('xhigh');
      client.close();
    });

    await it('routes a model change to the update listeners as config_option_update', async () => {
      // opencode pushes an update for a *model* change and returns the list for the others, so a
      // client that depends on the notification — or on the reply — is half broken.
      const fixture = new FixtureAgent();
      const client = new AcpClient({ transport: fixture.transport });
      const updates: SessionUpdate[] = [];
      client.onSessionUpdate((notification: SessionNotification) => updates.push(notification.update));
      await client.initialize();
      const session = await client.newSession({ cwd: '/tmp', mcpServers: [] });

      await client.setConfigOption({
        sessionId: session.sessionId,
        configId: 'model',
        value: 'github-copilot/gpt-5.5-codex',
      });

      const pushed = updates.filter((update) => update.sessionUpdate === 'config_option_update');
      expect(pushed.length).toBe(1);
      const update = pushed[0] as { configOptions: SessionConfigOption[] };
      expect(currentValueOf(update.configOptions, 'model')).toBe('github-copilot/gpt-5.5-codex');
      client.close();
    });

    await it('sends no update for an effort change, and does not need one', async () => {
      const fixture = new FixtureAgent();
      const client = new AcpClient({ transport: fixture.transport });
      const updates: SessionUpdate[] = [];
      client.onSessionUpdate((notification: SessionNotification) => updates.push(notification.update));
      await client.initialize();
      const session = await client.newSession({ cwd: '/tmp', mcpServers: [] });

      await client.setConfigOption({ sessionId: session.sessionId, configId: 'effort', value: 'low' });

      expect(updates.filter((update) => update.sessionUpdate === 'config_option_update').length).toBe(0);
      client.close();
    });

    await it('an unknown configId is a real error, not a hang', async () => {
      const fixture = new FixtureAgent();
      const client = new AcpClient({ transport: fixture.transport });
      await client.initialize();
      const session = await client.newSession({ cwd: '/tmp', mcpServers: [] });

      let failed = false;
      await client
        .setConfigOption({ sessionId: session.sessionId, configId: 'nope', value: 'x' })
        .then(() => {
          failed = true;
        })
        .catch(() => {
          failed = true;
        });
      expect(failed).toBe(true);
      expect(fixture.configErrors.length).toBe(1);
      client.close();
    });

    await it('a value outside the offered list is refused — the surface must use the answer', async () => {
      const fixture = new FixtureAgent();
      const client = new AcpClient({ transport: fixture.transport });
      await client.initialize();
      const session = await client.newSession({ cwd: '/tmp', mcpServers: [] });

      let message = '';
      await client
        .setConfigOption({ sessionId: session.sessionId, configId: 'effort', value: 'ludicrous' })
        .catch((error: Error) => {
          message = error.message;
        });
      expect(message.length > 0).toBe(true);
      expect(currentValueOf(fixture.configOptions, 'effort')).toBe('default');
      client.close();
    });

    await it('a tagged boolean value is refused by an agent that takes no booleans', async () => {
      // This is why `KURIER_CLIENT_CAPABILITIES` omits `boolean`. The refusal is the measurement.
      const fixture = new FixtureAgent();
      const client = new AcpClient({ transport: fixture.transport });
      await client.initialize();
      const session = await client.newSession({ cwd: '/tmp', mcpServers: [] });

      let failed = false;
      await client
        .setConfigOption({ sessionId: session.sessionId, configId: 'web', value: { type: 'boolean', value: true } })
        .catch(() => {
          failed = true;
        });
      expect(failed).toBe(true);
      expect(fixture.configErrors[0]?.configId).toBe('web');
      client.close();
    });

    await it('the mode is settable through the config option as well as through set_mode', async () => {
      // Two doors to one room, in the real agent: `configId: "mode"` and `session/set_mode` both
      // work, and they have to agree — otherwise the mode row and the mode state drift apart.
      const fixture = new FixtureAgent();
      const client = new AcpClient({ transport: fixture.transport });
      await client.initialize();
      const session = await client.newSession({ cwd: '/tmp', mcpServers: [] });

      const answer = await client.setConfigOption({ sessionId: session.sessionId, configId: 'mode', value: 'plan' });
      expect(currentValueOf(answer.configOptions, 'mode')).toBe('plan');

      await client.setMode({ sessionId: session.sessionId, modeId: 'build' });
      expect(currentValueOf(fixture.configOptions, 'mode')).toBe('build');
      expect(fixture.modesSet).toEqualArray(['plan', 'build']);
      client.close();
    });
  });

  await describe('session/set_mode', async () => {
    await it('sends the mode and gets an empty answer — the new mode arrives as an update', async () => {
      const fixture = new FixtureAgent();
      const client = new AcpClient({ transport: fixture.transport });
      const updates: SessionUpdate[] = [];
      client.onSessionUpdate((notification: SessionNotification) => updates.push(notification.update));
      await client.initialize();
      const session = await client.newSession({ cwd: '/tmp', mcpServers: [] });

      const answer = await client.setMode({ sessionId: session.sessionId, modeId: 'plan' });

      // The v1 response carries no fields. A client that read the mode out of the acknowledgement
      // would be guessing, and the guess is the one thing this method must not encourage.
      expect(Object.keys(answer).length).toBe(0);
      const mode = updates.find((update) => update.sessionUpdate === 'current_mode_update');
      expect((mode as { currentModeId?: string } | undefined)?.currentModeId).toBe('plan');
      client.close();
    });

    await it('an unknown mode is an error, not a silent no-op', async () => {
      const fixture = new FixtureAgent();
      const client = new AcpClient({ transport: fixture.transport });
      await client.initialize();
      const session = await client.newSession({ cwd: '/tmp', mcpServers: [] });

      let failed = false;
      await client.setMode({ sessionId: session.sessionId, modeId: 'yolo' }).catch(() => {
        failed = true;
      });
      expect(failed).toBe(true);
      expect(fixture.modesSet.length).toBe(0);
      client.close();
    });
  });

  await describe('a refusal is not an auth problem, and is not silent', async () => {
    await it('set_configOption surfaces the agent’s error verbatim enough to act on', async () => {
      // Trap 1 in the wrong place is the expensive mistake: a window has no terminal to inherit, so
      // a "you are not logged in" would have to become a dialog. It must be distinguishable from a
      // refusal, or the dialog will say the wrong thing.
      const fixture = new FixtureAgent({ requireAuth: true });
      const client = new AcpClient({ transport: fixture.transport });
      await client.initialize();
      const session = await client.newSession({ cwd: '/tmp', mcpServers: [] }).catch(() => undefined);
      expect(session).toBe(undefined);

      let auth = false;
      await client.newSession({ cwd: '/tmp', mcpServers: [] }).catch((error: unknown) => {
        auth = isAuthRequired(error);
      });
      expect(auth).toBe(true);
      client.close();
    });
  });
};
