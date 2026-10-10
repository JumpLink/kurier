/**
 * Reading a `usage_update` without printing a float that ate the line.
 *
 * **The defect this exists to fix is one line of output.** An agent reports a cost as a JSON number,
 * and JSON numbers are IEEE doubles: opencode answers `0.0014555100000000001 USD`, seventeen
 * significant digits for a charge of about a tenth of a cent. Rendered as `${cost.amount}` that is
 * what lands in the transcript, and it is worse than ugly — it is *misinformation*, because it says
 * the charge was exactly that number and it was not. A transcript is a record of what happened
 * (`AGENTS.md` § Privacy); a record of a float is a record of a rounding artefact.
 *
 * **So the number is rounded, and the rounding is a decision, which is why it is a function in
 * `core/` and not a `toFixed` at the call site.** Two questions have no obvious answer and both are
 * settled here, once, where a test can pin them:
 *
 * 1. **How many digits.** Four. A cost this small is a per-token fraction of a cent, and six digits
 *    of it is noise; four keeps `0.0015` and still separates any two prices a person would care
 *    about. Token counts are whole numbers by definition and get none.
 * 2. **What a cost too small for four digits says.** `0`, not `0.0000`. A charge that rounds to
 *    nothing is *not* a free turn — free models really do report `0`, and those must not look like
 *    the ones that merely rounded away — so the sub-precision case prints `<0.0001`, which is true
 *    whatever the number was. **A negative amount gets `>-0.0001`**, because `<0.0001` on its own
 *    says the charge was positive and small, and a refund is neither.
 *
 * **Fixed English, no `Intl`.** `Intl.NumberFormat` would give `0.0015` here and `0,0015` under a
 * German locale, and a transcript that changes shape with the environment is a transcript nobody can
 * grep. `AGENTS.md` fixes the house rule; `core/session-groups.ts` §2 is where it is argued.
 *
 * **The money keeps its currency and loses nothing else.** A cost without a currency is still a cost
 * and is printed without one rather than with a guessed `USD` — the agent that reported the amount
 * knows the unit and did not send it, and inventing one is the same class of mistake as printing the
 * unrounded float.
 */

/** Decimal places a cost is rounded to. See the file header; four, and why. */
const COST_DECIMALS = 4;

/** What a cost too small to print at `COST_DECIMALS` says. True whatever the amount was. */
const COST_TOO_SMALL = '<0.0001';
/** The same, for a negative amount: the sign is part of the fact, so it is written out. */
const COST_NEGATIVE_TOO_SMALL = '>-0.0001';

/**
 * A number as the transcript prints it.
 *
 * **Whole numbers print whole.** `120` stays `120` and not `120.0000`: token counts are integers by
 * definition, so a decimal place on them would be a claim about precision nobody has.
 *
 * **`Math.abs(value) >= 10 ** 21` goes through `BigInt`** rather than `String`, which switches to
 * `1e+21` at that magnitude — and an exponent in a transcript line is not a line anybody can read a
 * number off. Nothing real reaches it; it is here so the function cannot produce one.
 *
 * **Non-finite input prints as itself** (`NaN`, `Infinity`). An agent that reports a nonsense number
 * gets to see its own nonsense in the record — silently rounding it to `0` would turn a bug in the
 * agent into a plausible-looking line.
 */
export function formatUsageNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Math.abs(value) >= 10 ** 21) return bigintDigits(value);
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(COST_DECIMALS)));
}

/**
 * The digits of a whole number too large for `String()`, which switches to `1e+21` at that magnitude.
 *
 * **A `BigInt` conversion and nothing cleverer.** The value is already known to be an integer (the
 * caller only gets here past `Number.isInteger`), so `BigInt` is exact, and `.toString()` on a
 * `BigInt` is the plain digit string — no exponent, no separator, no locale. A transcript line with
 * `1.5e+21` in it is not a line anybody can read a number off.
 */
function bigintDigits(value: number): string {
  return BigInt(value).toString();
}

/** The cost an agent reported, as one clause: `0.0015 USD`, or `<0.0001 EUR`, or `0` alone. */
export function formatCost(cost: { amount?: number; currency?: string } | null | undefined): string {
  const amount = cost?.amount;
  if (amount === undefined || amount === null || typeof amount !== 'number') return '';
  const currency = typeof cost?.currency === 'string' ? cost.currency.trim() : '';
  if (!Number.isFinite(amount)) {
    // No rounding is meaningful here, so the number is printed whole and the currency kept: the point
    // is that the agent said something impossible, and the line has to say so.
    return currency ? `${String(amount)} ${currency}` : String(amount);
  }
  const printed =
    Math.abs(amount) < 10 ** -COST_DECIMALS && amount !== 0
      ? amount > 0
        ? COST_TOO_SMALL
        : COST_NEGATIVE_TOO_SMALL
      : formatUsageNumber(amount);
  return currency ? `${printed} ${currency}` : printed;
}

/**
 * The whole `usage_update`, as the one clause the transcript carries.
 *
 * **Every field printed here is printed when the agent sent it, and one it did not send is not
 * mentioned.** An agent that reports input and output tokens and no cost gets no trailing empty
 * currency; one that reports only a cost gets only the cost. This is the transcript, not a dashboard:
 * it records what was said.
 *
 * **`cacheReadTokens` and `cacheWriteTokens` are deliberately still not printed.** The schema has them
 * and this function could say them, and that is exactly why they are named in a comment rather than
 * added: a cost line that grows two more numbers is a change to what the transcript *says*, which is
 * a decision of its own and not the one this file exists to make. The fix here is the float.
 *
 * `'reported'` for an update with nothing in it, because the transcript is a record of events and a
 * blank line is not an event. The word is fixed English.
 */
export function describeUsage(update: {
  inputTokens?: number;
  outputTokens?: number;
  cost?: { amount?: number; currency?: string } | null;
}): string {
  const parts: string[] = [];
  if (typeof update.inputTokens === 'number') parts.push(`in ${formatUsageNumber(update.inputTokens)}`);
  if (typeof update.outputTokens === 'number') parts.push(`out ${formatUsageNumber(update.outputTokens)}`);
  const cost = formatCost(update.cost);
  if (cost) parts.push(cost);
  return parts.join(', ') || 'reported';
}
