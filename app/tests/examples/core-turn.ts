// The example in packages/core/README.md, type-checked with the app and not run. Keep the two in step.
import { denyAll } from '@kurier/acp';
import { gatherResolveContext, kurierPathsUnder, openAgent, resolveDefault, runTurn } from '@kurier/core';

export async function sayHello(dataRoot: string): Promise<void> {
  const paths = kurierPathsUnder(dataRoot);
  const agent = resolveDefault(gatherResolveContext(paths));
  if (!agent) throw new Error('no agent found');

  const handle = await openAgent({ command: agent.command, gate: { permission: denyAll } });
  try {
    const { sessionId } = await handle.client.newSession({ cwd: process.cwd(), mcpServers: [] });
    await runTurn(handle.client, {
      sessionId,
      text: 'Say hello.',
      onUpdate: (notification) => console.log(notification.update.sessionUpdate),
    });
  } finally {
    await handle.close();
  }
}
