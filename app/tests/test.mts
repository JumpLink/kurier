// Test entry: aggregates every *.test.ts suite (each a default-exported async fn) and runs them
// under @gjsify/unit, on GJS and Node both (`gjsify test`). Keep this list in sync when adding a
// test file.
import { run } from '@gjsify/unit';

import jsonrpc from './unit/acp/jsonrpc.test.ts';
import client from './unit/acp/client.test.ts';
import permissionQueue from './unit/acp/permission-queue.test.ts';
import gate from './unit/acp/gate.test.ts';
import opencodeShape from './unit/acp/opencode-shape.test.ts';
import configOptions from './unit/acp/config-options.test.ts';

import sessionModel from './unit/session/model.test.ts';
import sessionStore from './unit/session/store.test.ts';

import config from './unit/core/config.test.ts';
import configRow from './unit/core/config-row.test.ts';
import failure from './unit/core/failure.test.ts';
import usage from './unit/core/usage.test.ts';
import policy from './unit/core/policy.test.ts';
import interrupt from './unit/core/interrupt.test.ts';
import transcript from './unit/core/transcript.test.ts';
import composerState from './unit/core/composer-state.test.ts';
import agents from './unit/core/agents.test.ts';
import sandbox from './unit/core/sandbox.test.ts';
import devAgent from './unit/core/dev-agent.test.ts';
import paths from './unit/core/paths.test.ts';
import scroll from './unit/core/scroll.test.ts';
import sessionGroups from './unit/core/session-groups.test.ts';
import transcriptItems from './unit/core/transcript-items.test.ts';
import turn from './unit/core/turn.test.ts';
import permission from './unit/core/permission.test.ts';
import agentSession from './unit/core/agent-session.test.ts';

import hookValue from './unit/gui/hook-value.test.ts';

import smoke from './unit/smoke.test.ts';

run({
  jsonrpc,
  client,
  permissionQueue,
  gate,
  opencodeShape,
  configOptions,
  sessionModel,
  sessionStore,
  config,
  configRow,
  failure,
  usage,
  policy,
  interrupt,
  transcript,
  composerState,
  agents,
  sandbox,
  devAgent,
  paths,
  scroll,
  sessionGroups,
  transcriptItems,
  turn,
  permission,
  agentSession,
  hookValue,
  smoke,
});
