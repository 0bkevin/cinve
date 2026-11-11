// A server-only JSX runtime that renders to HTML strings. tsc compiles the
// pages' JSX into h() calls (tsconfig jsxFactory), so no bundler or client
// framework is involved. Text and attribute values are always escaped; only
// Html values, produced by this runtime or by raw(), pass through verbatim.

export class Html {
  constructor(readonly value: string) {}
  toString() { return this.value; }
}

export type Child = Html | string | number | boolean | null | undefined | Child[];
type AttributeValue = string | number | boolean | null | undefined;
export type Props = Record<string, AttributeValue | Child> & { children?: Child };
export type Component<P = {}> = (props: P & { children?: Child }) => Html;

declare global {
  namespace JSX {
    type Element = Html;
    interface IntrinsicElements { [tag: string]: Record<string, AttributeValue | Child> }
    interface ElementChildrenAttribute { children: {} }
  }
}

export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Trusted markup that must not be escaped, such as an inline SVG icon. */
export const raw = (markup: string) => new Html(markup);

const voidElements = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const validName = /^[a-zA-Z][a-zA-Z0-9:._-]*$/;

function renderChildren(child: Child): string {
  if (child === null || child === undefined || typeof child === 'boolean') return '';
  if (Array.isArray(child)) return child.map(renderChildren).join('');
  if (child instanceof Html) return child.value;
  return escapeHtml(String(child));
}

function renderAttributes(props: Record<string, unknown>): string {
  let out = '';
  for (const [name, value] of Object.entries(props)) {
    if (name === 'children' || value === false || value === null || value === undefined) continue;
    if (!validName.test(name)) throw new Error(`Invalid attribute name: ${name}`);
    // Pages run under a CSP without 'unsafe-inline': behavior lives in
    // /assets scripts and styling in /assets stylesheets.
    if (/^on/i.test(name) || name === 'style') throw new Error(`Inline ${name} is not allowed`);
    out += value === true ? ` ${name}` : ` ${name}="${escapeHtml(String(value))}"`;
  }
  return out;
}

// Components are typed where they are used (tsc checks each JSX call
// against the component's own props), so the factory only needs to know it
// receives one: `never` accepts any props type without opting out of checks.
type AnyComponent = (props: never) => Html;

export function h(tag: string | AnyComponent, props: Record<string, unknown> | null, ...children: Child[]): Html {
  const all = { ...props, children: children.length === 0 ? props?.children : children.length === 1 ? children[0] : children };
  if (typeof tag === 'function') return (tag as (props: typeof all) => Html)(all);
  if (!validName.test(tag)) throw new Error(`Invalid element name: ${tag}`);
  const open = `<${tag}${renderAttributes(all)}>`;
  return new Html(voidElements.has(tag) ? open : `${open}${renderChildren(all.children as Child)}</${tag}>`);
}

export const Fragment = ({ children }: { children?: Child }) => new Html(renderChildren(children));

/** Renders a complete document. */
export const renderDocument = (root: Html) => `<!doctype html>${root.value}`;
