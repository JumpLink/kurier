/**
 * The transport: the seam between "ACP" and "a subprocess".
 *
 * `packages/acp` never spawns anything, never imports `node:child_process` and never touches
 * `gi://`. Everything a connection needs from the outside is this one interface, so the whole
 * protocol is testable on both runtimes against an injected fixture — and, in the other direction,
 * so lotse can hand the same connection to a stdio child process on GJS, to a WebSocket in a
 * browser extension tomorrow, or to an in-process stub in a test, without the protocol noticing.
 *
 * This is postbote's `store`-knows-no-backend rule, one layer up.
 */

export type TransportListener = (data: string) => void;
export type CloseListener = (reason: Error | undefined) => void;

export interface Transport {
  /** Send one JSON-RPC line. The implementation appends the newline; the caller does not. */
  write(data: string): void;
  /** Called once per complete line the peer sent, in order. */
  onMessage(listener: TransportListener): void;
  /** Called once when the peer is gone. `reason` is undefined for a clean exit. */
  onClose(listener: CloseListener): void;
  /** Terminate the peer. Must be idempotent. */
  close(): void;
  /** True while the peer is still there. */
  readonly closed: boolean;
}

/**
 * A transport that is already closed. Every failure path funnels here, so a request that arrives
 * after the peer died rejects with one message instead of hanging forever — a hang is the failure
 * mode that costs an afternoon, a rejected promise costs a log line.
 */
export class ClosedTransport implements Transport {
  readonly closed = true;
  readonly reason: Error;

  constructor(reason: string) {
    this.reason = new Error(reason);
  }

  write(_data: string): void {
    throw this.reason;
  }

  onMessage(_listener: TransportListener): void {}

  /**
   * Called at once, not in a microtask. The peer is already gone when the listener subscribes, so
   * a deferred call would leave a window in which `write` throws at a caller whose close listener
   * has not run yet — an `AcpClient` built on this would report `closed === false` and then throw.
   */
  onClose(listener: CloseListener): void {
    listener(this.reason);
  }

  close(): void {}
}

/**
 * Wraps any two-ended thing into a `Transport`. Used by the stdio adapter in `app/`; kept here so
 * the interface and its adapter live in one place and the app holds no protocol knowledge.
 */
export interface RawChannel {
  send(data: string): void;
  onData(listener: (data: string) => void): void;
  onEnd(listener: (reason: Error | undefined) => void): void;
  terminate(): void;
  readonly isClosed: boolean;
}

export function channelTransport(channel: RawChannel): Transport {
  return {
    get closed() {
      return channel.isClosed;
    },
    write: (data) => channel.send(data),
    onMessage: (listener) => channel.onData(listener),
    onClose: (listener) => channel.onEnd(listener),
    close: () => channel.terminate(),
  };
}
