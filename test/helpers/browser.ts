// A minimal stand-in for the DOM members the hosted site's browser scripts
// use, so tests can run the exact served script text in a vm context.
import vm from 'node:vm';
import { load } from 'cheerio';

export class FakeElement {
  hidden = false; disabled = false; textContent = ''; className = ''; value = ''; type = '';
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  onclick: (() => Promise<void> | void) | null = null;
  onsubmit: ((event: { preventDefault(): void }) => Promise<void> | void) | null = null;
  resets = 0;
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  reset() { this.resets++; }
  append(...nodes: FakeElement[]) { this.children.push(...nodes); }
}

/** Every element of `html` that has an id, with its text, type, value and hidden/disabled flags. */
export function fakeElements(html: string): Map<string, FakeElement> {
  const $ = load(html), elements = new Map<string, FakeElement>();
  $('[id]').each((_, node) => {
    const source = $(node), element = new FakeElement();
    element.textContent = source.text(); element.type = source.attr('type') ?? ''; element.value = source.attr('value') ?? '';
    element.hidden = source.is('[hidden]'); element.disabled = source.is('[disabled]');
    const id = source.attr('id');
    if (id) elements.set(id, element);
  });
  return elements;
}

/**
 * Runs a classic script in a fresh context whose document holds `elements`.
 * A getElementById for an id the page lacks returns null, as in a browser, so
 * a renamed element fails the script instead of passing silently.
 */
export function runScript(script: string, elements: Map<string, FakeElement>, globals: Record<string, unknown> = {}) {
  const document = { getElementById: (id: string) => elements.get(id) ?? null, createElement: () => new FakeElement() };
  new vm.Script(script, { filename: 'served-script.js' }).runInContext(vm.createContext({ document, ...globals }));
}

/** Lets pending promise callbacks and timers that are already due run. */
export const settle = () => new Promise<void>(resolve => setImmediate(resolve));
