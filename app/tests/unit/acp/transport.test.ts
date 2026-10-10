import { describe, expect, it } from '@gjsify/unit';

import { AcpClient } from '@lotse/acp/client';
import { ClosedTransport } from '@lotse/acp/transport';

export default async () => {
  await describe('ClosedTransport', async () => {
    await it('tells a close listener at once, before a write can throw at the caller', async () => {
      const transport = new ClosedTransport('the agent never started');
      let heard: Error | undefined;
      transport.onClose((reason) => {
        heard = reason;
      });
      expect(heard).toBe(transport.reason);
      expect(() => transport.write('{}')).toThrow();
    });

    await it('leaves a client built on it closed before its first call', async () => {
      const client = new AcpClient({ transport: new ClosedTransport('the agent never started') });
      expect(client.closed).toBe(true);
      await expect(client.initialize()).rejects.toThrow(/closed ACP connection/);
    });
  });
};
