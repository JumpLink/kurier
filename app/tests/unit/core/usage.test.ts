/**
 * `core/usage.ts` — a `usage_update` read without printing the float.
 *
 * The headline case is in the first test and is a real measurement, not a constructed one: an agent
 * answers a cost of `0.0014555100000000001` and the transcript used to carry all seventeen digits of
 * it.
 */
import { describe, expect, it } from '@gjsify/unit';

import { describeUsage, formatCost, formatUsageNumber } from '@kurier/core';

export default async function usage(): Promise<void> {
  await describe('usage — the number a cost is rounded to', async () => {
    await it('prints four decimals, not the seventeen the double actually holds', async () => {
      // The measured value. It is what opencode reports for a cheap turn, and printing it raw is what
      // put a rounding artefact into a transcript as if it were a price.
      expect(formatUsageNumber(0.0014555100000000001)).toBe('0.0015');
    });

    await it('leaves a whole number whole', async () => {
      // Token counts are integers by definition. `120.0000` would claim a precision nobody has.
      expect(formatUsageNumber(120)).toBe('120');
      expect(formatUsageNumber(0)).toBe('0');
      expect(formatUsageNumber(-45)).toBe('-45');
    });

    await it('rounds a value that needs carrying, and keeps its sign', async () => {
      expect(formatUsageNumber(1.23456)).toBe('1.2346');
      expect(formatUsageNumber(-1.23456)).toBe('-1.2346');
      expect(formatUsageNumber(0.5)).toBe('0.5');
      expect(formatUsageNumber(-0.5)).toBe('-0.5');
    });

    await it('never prints a bare minus for a negative that rounds to nothing', async () => {
      // `(-0).toFixed(4)` is `'0.0000'`, so this cannot leak a `-0`; the sub-precision wording is
      // `formatCost`'s job and lives there.
      expect(formatUsageNumber(-0)).toBe('0');
      expect(formatUsageNumber(-0.00006)).toBe('-0.0001');
    });

    await it('prints what an agent said when the number is not finite', async () => {
      // Rounding `NaN` to `0` would turn a bug in the agent into a plausible-looking line.
      expect(formatUsageNumber(Number.NaN)).toBe('NaN');
      expect(formatUsageNumber(Number.POSITIVE_INFINITY)).toBe('Infinity');
    });

    await it('never prints exponent notation', async () => {
      // `String` switches to `1e+21` at that magnitude, and an exponent in a transcript line is
      // unreadable. Nothing real reaches it; the guard exists so the function cannot produce one.
      expect(formatUsageNumber(1.5e21)).toBe('1500000000000000000000');
      expect(formatUsageNumber(1.5e21)).not.toContain('e');
    });
  });

  await describe('usage — the cost, with its currency', async () => {
    await it('keeps the currency the agent sent', async () => {
      expect(formatCost({ amount: 0.0014555100000000001, currency: 'USD' })).toBe('0.0015 USD');
    });

    await it('says a cost too small for four decimals is below them, not zero', async () => {
      // A free model really reports `0`, and that must not look like a charge that rounded away.
      expect(formatCost({ amount: 0.000001, currency: 'USD' })).toBe('<0.0001 USD');
      expect(formatCost({ amount: 0, currency: 'USD' })).toBe('0 USD');
    });

    await it('writes the sign into a sub-precision negative, because `<0.0001` alone claims otherwise', async () => {
      // A refund is not a small charge. `<0.0001 USD` read off a negative would say the money was
      // positive and tiny, which is the opposite of what was reported.
      expect(formatCost({ amount: -0.000001, currency: 'USD' })).toBe('>-0.0001 USD');
      expect(formatCost({ amount: -0.0000001, currency: 'USD' })).toBe('>-0.0001 USD');
      expect(formatCost({ amount: -0.000001 })).toBe('>-0.0001');
    });

    await it('rounds a negative that is big enough to print, sign intact', async () => {
      expect(formatCost({ amount: -1.23456, currency: 'USD' })).toBe('-1.2346 USD');
      expect(formatCost({ amount: -2, currency: 'USD' })).toBe('-2 USD');
    });

    await it('prints no currency rather than guessing one', async () => {
      // The agent that reported the amount knows the unit and did not send it. Inventing `USD` is the
      // same mistake as printing the unrounded float.
      expect(formatCost({ amount: 1.5 })).toBe('1.5');
      expect(formatCost({ amount: 1.5, currency: '  ' })).toBe('1.5');
    });

    await it('produces nothing for a cost that is absent, null, or not an object', async () => {
      expect(formatCost(null)).toBe('');
      expect(formatCost(undefined)).toBe('');
      expect(formatCost({})).toBe('');
      expect(formatCost({ amount: '1.5' } as never)).toBe('');
    });

    await it('keeps the agent’s own impossible number visible, with its currency', async () => {
      expect(formatCost({ amount: Number.NaN, currency: 'USD' })).toBe('NaN USD');
    });
  });

  await describe('usage — the whole clause', async () => {
    await it('is what the measured cost line reads', async () => {
      expect(
        describeUsage({
          inputTokens: 120,
          outputTokens: 45,
          cost: { amount: 0.0014555100000000001, currency: 'USD' },
        }),
      ).toBe('in 120, out 45, 0.0015 USD');
    });

    await it('says only what the agent sent', async () => {
      expect(describeUsage({ inputTokens: 120 })).toBe('in 120');
      expect(describeUsage({ cost: { amount: 2, currency: 'EUR' } })).toBe('2 EUR');
      expect(describeUsage({})).toBe('reported');
    });

    await it('does not change shape with the environment — fixed English, no Intl', async () => {
      // The same call twice with a different decimal separator available must produce the same bytes;
      // a transcript that shifts with the locale is one nobody can grep.
      expect(describeUsage({ inputTokens: 120, outputTokens: 45 })).toBe('in 120, out 45');
    });
  });
}
