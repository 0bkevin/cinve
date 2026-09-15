import { load } from 'cheerio';
import { DataError, text } from './core.js';

export type Obj = Record<string, unknown>;
export const object = (v: unknown): Obj => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
export function rows(v: unknown, name: string): Obj[] {
  if (!Array.isArray(v) || v.some(r => !r || typeof r !== 'object' || Array.isArray(r))) throw new DataError('error', `Cambió la estructura del proveedor: ${name}.`);
  return v as Obj[];
}
/** Parses JSON only; never evaluates page scripts. Concatenation handles split Flight records. */
export function flight(html: string): unknown[] {
  const $ = load(html); let stream = '';
  $('script').each((_, e) => {
    const source = $(e).html() ?? '';
    const calls = /self\.__next_f\.push\(/g;
    for (let match; (match = calls.exec(source));) {
      const start = match.index + match[0].length;
      if (source[start] !== '[') continue;
      let depth = 0, quoted = false, escaped = false, closed = false;
      for (let i = start; i < source.length; i++) {
        const char = source[i];
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if (char === '[') depth++;
        else if (char === ']' && --depth === 0) {
          try { const value = JSON.parse(source.slice(start, i + 1)); if (value[0] === 1 && typeof value[1] === 'string') stream += value[1]; } catch { /* Non-JSON JavaScript is deliberately ignored. */ }
          calls.lastIndex = i + 1; closed = true;
          break;
        }
      }
      // Never rescan overlapping suffixes of an unterminated call (quadratic CPU cost).
      if (!closed) break;
    }
  });
  const result: unknown[] = [];
  for (const line of stream.split('\n')) {
    const i = line.indexOf(':'); if (i < 0) continue;
    try { result.push(JSON.parse(line.slice(i + 1))); } catch { /* Import and length-prefixed text records aren't JSON. */ }
  }
  if (!result.length) throw new DataError('error', 'No se encontraron datos Next.js legibles; posible cambio del proveedor.');
  return result;
}
export function findField(roots: unknown[], key: string): unknown {
  for (const node of objects(roots)) if (Object.hasOwn(node, key)) return node[key];
  return undefined;
}
/** Bounded, iterative traversal: untrusted JSON cannot exhaust the JavaScript stack. */
export function* objects(root: unknown): Generator<Obj> {
  const stack = [{ value: root, depth: 0 }]; let visited = 0;
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (++visited > 100000 || depth > 64) throw new DataError('error', 'Los datos del proveedor exceden los límites de estructura.');
    if (!value || typeof value !== 'object') continue;
    if (!Array.isArray(value)) yield value as Obj;
    const children = Object.values(value);
    if (stack.length + children.length > 100000) throw new DataError('error', 'Los datos del proveedor exceden los límites de estructura.');
    for (let i = children.length - 1; i >= 0; i--) stack.push({ value: children[i], depth: depth + 1 });
  }
}
export function decodeLabel(value: unknown): string {
  let s = text(value).replace(/\\u([0-9a-fA-F]{4})/g, (_, n: string) => String.fromCharCode(parseInt(n, 16)));
  if (/[ÃÂ]/.test(s)) {
    const repaired = Buffer.from(s, 'latin1').toString('utf8');
    if (!repaired.includes('�')) s = repaired;
  }
  return s;
}
export function requiredText(row: Obj, key: string): string {
  const value = text(row[key]);
  if (!value) throw new DataError('error', `Campo obligatorio ausente: ${key}.`);
  return value;
}
