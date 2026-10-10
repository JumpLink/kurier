/** `frontends/gui/tool-line.ts` — a recorded tool line read back into a title, a status and an icon. */
import { describe, expect, it } from '@gjsify/unit';

import { parseToolLine, toolIcon } from '../../../src/frontends/gui/tool-line.ts';

export default async () => {
  await describe('parseToolLine', async () => {
    await it('splits the title from a known status', async () => {
      const line = parseToolLine('Read config.json — completed');
      expect(line.title).toBe('Read config.json');
      expect(line.status?.label).toBe('Done');
      expect(line.status?.tone).toBe('done');
    });
    await it('leaves a status-only line untitled', async () => {
      // No title rather than an invented one: the caller draws a status caption instead of a card.
      expect(parseToolLine('— failed').title).toBe('');
      expect(parseToolLine('— failed').status?.tone).toBe('failed');
    });
    await it('leaves a line without a known status whole', async () => {
      const line = parseToolLine('Run build — weird');
      expect(line.title).toBe('Run build — weird');
      expect(line.status).toBe(null);
    });
  });
  await describe('toolIcon', async () => {
    await it('reads the first word, with a fallback', async () => {
      expect(toolIcon('Search src')).toBe('edit-find-symbolic');
      expect(toolIcon('edit')).toBe('document-edit-symbolic');
      expect(toolIcon('Frobnicate')).toBe('system-run-symbolic');
    });
  });
};
