/**
 * `frontends/gui/hook-value.ts` — how a `KU_APP_*` value is read.
 *
 * Both runtimes, no display, and that is the point of the file existing: the rules it holds used to be
 * three closures inside `readHooks`, which imports the framework's reader and with it `Adw`, so no
 * test could reach them on Node. A rule with no test is a rule the next key gets wrong.
 */
import { describe, expect, it } from '@gjsify/unit';

import { hookFlag, hookList, hookValue } from '../../../src/frontends/gui/hook-value.ts';

export default async function run(): Promise<void> {
  await describe('a dev hook value', async () => {
    await it('is the trimmed string, or nothing when unset', async () => {
      expect(hookValue({}, 'SESSION')).toBe(undefined);
      expect(hookValue({ KU_APP_SESSION: '  fixture-2  ' }, 'SESSION')).toBe('fixture-2');
    });

    await it('treats an empty value as unset, because a shell makes one without a word', async () => {
      // `export FOO=` leaves `FOO=''`, and a hook that read that as set would send an empty prompt —
      // which `prompt()` refuses, so the run would look like the hook was ignored instead of empty.
      expect(hookValue({ KU_APP_SESSION: '' }, 'SESSION')).toBe(undefined);
      expect(hookValue({ KU_APP_SESSION: '   ' }, 'SESSION')).toBe(undefined);
    });

    await it('does not read another hook’s name out of a longer key', async () => {
      // The prefix is added by the reader, so a key that already carries it is not a hook.
      expect(hookValue({ KU_APP_KU_APP_SESSION: 'fixture-1' }, 'SESSION')).toBe(undefined);
    });
  });

  await describe('a dev hook flag', async () => {
    await it('is on for anything that is not one of the two spellings of off', async () => {
      expect(hookFlag({ KU_APP_THINKING: '1' }, 'THINKING')).toBe(true);
      expect(hookFlag({ KU_APP_THINKING: 'yes' }, 'THINKING')).toBe(true);
      // Not `Boolean(value)`: a non-empty string is truthy, which is how `'0'` used to mean on.
      expect(hookFlag({ KU_APP_THINKING: '0' }, 'THINKING')).toBe(false);
      expect(hookFlag({ KU_APP_THINKING: 'false' }, 'THINKING')).toBe(false);
      expect(hookFlag({ KU_APP_THINKING: 'FALSE' }, 'THINKING')).toBe(false);
      expect(hookFlag({ KU_APP_THINKING: 'False' }, 'THINKING')).toBe(false);
      expect(hookFlag({ KU_APP_THINKING: '' }, 'THINKING')).toBe(false);
      expect(hookFlag({}, 'THINKING')).toBe(false);
    });

    await it('is off for a zero with whitespace around it, which the trim has to reach', async () => {
      // `' 0'` is the same word as `'0'` to whoever typed it, and a `KU_APP_STOP= 0` in a script is
      // how that happens. A padded `false` is the same story.
      expect(hookFlag({ KU_APP_STOP: ' 0 ' }, 'STOP')).toBe(false);
      expect(hookFlag({ KU_APP_STOP: ' False ' }, 'STOP')).toBe(false);
    });
  });

  await describe('a dev hook list', async () => {
    // `toEqual` in `@gjsify/unit` is `===`, so a list is compared as the string it is: two runs that
    // differ only in a trailing comma are two different `join()` results, which is the whole claim.
    const list = (env: Record<string, string | undefined>): string => hookList(env, 'SWITCH').join('|');

    await it('is empty when unset, and one entry when a bare id is given', async () => {
      expect(list({})).toBe('');
      expect(list({ KU_APP_SWITCH: '' })).toBe('');
      expect(list({ KU_APP_SWITCH: 'fixture-1' })).toBe('fixture-1');
    });

    await it('keeps the order, because a walk is not a set', async () => {
      expect(list({ KU_APP_SWITCH: 'fixture-1,fixture-2' })).toBe('fixture-1|fixture-2');
      expect(list({ KU_APP_SWITCH: 'fixture-2, fixture-1' })).toBe('fixture-2|fixture-1');
    });

    await it('drops the blanks a shell leaves behind, rather than asking for a session named ""', async () => {
      expect(list({ KU_APP_SWITCH: 'fixture-1,' })).toBe('fixture-1');
      expect(list({ KU_APP_SWITCH: ',fixture-1' })).toBe('fixture-1');
      expect(list({ KU_APP_SWITCH: ',' })).toBe('');
      expect(list({ KU_APP_SWITCH: ' , ' })).toBe('');
      expect(hookList({ KU_APP_SWITCH: ' , ' }, 'SWITCH').length).toBe(0);
    });
  });
}
