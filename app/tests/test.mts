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
import policy from './unit/core/policy.test.ts';
import interrupt from './unit/core/interrupt.test.ts';
import transcript from './unit/core/transcript.test.ts';
import composerState from './unit/core/composer-state.test.ts';
import agents from './unit/core/agents.test.ts';
import paths from './unit/core/paths.test.ts';
import sessionGroups from './unit/core/session-groups.test.ts';
import transcriptItems from './unit/core/transcript-items.test.ts';

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
  policy,
  interrupt,
  transcript,
  composerState,
  agents,
  paths,
  sessionGroups,
  transcriptItems,
  smoke,
});
