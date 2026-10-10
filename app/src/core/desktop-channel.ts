/**
 * The first `ServeChannel`: a desktop notification over `org.freedesktop.Notifications`.
 *
 * Gio D-Bus rather than GNotification, because `serve` is not a `GApplication` and has no desktop
 * file to attach one to. Imported lazily by `serve` (`await import`), so nothing that merely lists
 * or answers questions loads GI, and a session without a notification daemon falls back to stderr
 * instead of failing the run that wanted to ask (`stderr-channel.ts`).
 */

import Gio from '@girs/gio-2.0';
import GLib from '@girs/glib-2.0';

import type { ServeChannel, ServeMessage, ServeUser } from '@lotse/core';

import { stderrChannel } from './stderr-channel.ts';

const NAME = 'org.freedesktop.Notifications';
const PATH = '/org/freedesktop/Notifications';

export function desktopChannel(onProblem: (problem: string) => void): ServeChannel {
  const bus = Gio.bus_get_sync(Gio.BusType.SESSION, null);
  return {
    name: 'desktop',
    send: (_user: ServeUser, message: ServeMessage) => {
      try {
        bus.call_sync(
          NAME,
          PATH,
          NAME,
          'Notify',
          new GLib.Variant('(susssasa{sv}i)', [
            'lotse',
            0,
            message.questionId ? 'dialog-question' : 'dialog-information',
            message.title,
            message.body,
            [],
            {},
            -1,
          ]),
          null,
          Gio.DBusCallFlags.NONE,
          5_000,
          null,
        );
      } catch (error) {
        onProblem(`desktop notification failed: ${error instanceof Error ? error.message : String(error)}`);
        stderrChannel().send(_user, message);
      }
    },
  };
}
