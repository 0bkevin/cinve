// Parser warnings the adapters emit while reading one call's provider data,
// deduplicated by kind and bounded before they reach the result.
import type { ReadContext } from '../http/read-context.js';

const providerWarningKinds = 32;
const providerWarningLabelLength = 120;
type ProviderWarningState = { entries: Map<string, { index: number; count: number; base: string }>; suppressed: number; aggregateIndex?: number };
const providerWarningStates = new WeakMap<ReadContext, ProviderWarningState>();

export function warningLabel(value: unknown, max = providerWarningLabelLength): string {
  const textValue = typeof value === 'string' ? value : String(value ?? '');
  const compact = textValue.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

/** Keep parser diagnostics bounded before they enter the request-scoped context. */
export function providerWarning(c: ReadContext, key: string, message: string | (() => string)) {
  const state: ProviderWarningState = providerWarningStates.get(c) ?? { entries: new Map(), suppressed: 0 };
  providerWarningStates.set(c, state);
  const existing = state.entries.get(key);
  if (existing) {
    existing.count++;
    return;
  }
  if (state.entries.size < providerWarningKinds) {
    const bounded = warningLabel(typeof message === 'function' ? message() : message, 512);
    const index = c.warnings.length;
    c.warnings.push(bounded);
    state.entries.set(key, { index, count: 1, base: bounded.replace(/ \(repeated \d+ times\)\.$/, '') });
    return;
  }
  state.suppressed++;
  if (state.aggregateIndex === undefined) {
    state.aggregateIndex = c.warnings.length;
    c.warnings.push('Repeated or excess provider diagnostics were omitted; the response may be partial.');
  }
}

export function providerWarningSummary(c: ReadContext) {
  const state = providerWarningStates.get(c);
  if (!state) return;
  for (const entry of state.entries.values()) {
    if (entry.count > 1) c.warnings[entry.index] = `${entry.base} (repeated ${entry.count} times).`;
  }
  if (state.aggregateIndex !== undefined && state.suppressed > 1) c.warnings[state.aggregateIndex] = `${state.suppressed} repeated or excess provider diagnostics were omitted; the response may be partial.`;
}
