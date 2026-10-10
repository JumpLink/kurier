/**
 * The fallback `ServeChannel`: the message on stderr, which `journalctl --user -u lotse-serve` shows.
 * Its own file, without GI, so `lotse answer` and a session without a notification daemon can use it.
 */

import type { ServeChannel } from '@lotse/core';

export function stderrChannel(): ServeChannel {
  return {
    name: 'stderr',
    send: (_user, message) => {
      process.stderr.write(`[${message.title}] ${message.body}\n`);
    },
  };
}
