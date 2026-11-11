import { createHash } from 'node:crypto';
import { DataError, folded, Id, text } from './core.js';
import type { DataItem } from './core.js';
import { object } from './parsers.js';
import type { ReadContext } from './http.js';

/** Preserve named directory entries independently of code availability. */
export function parseCinemaDirectory(fields: unknown[], city: string, url: string, c: ReadContext): DataItem[] {
  const records: { id: string; name: string; address: string; identity: string }[] = [];
  let skipped = false;
  for (const field of fields) {
    if (!Array.isArray(field)) { skipped = true; continue; }
    for (const raw of field) {
      const row = object(raw), name = text(row.name);
      if (!name || name.length > 512) { skipped = true; continue; }
      const address = text(row.address);
      records.push({ id: text(row.id), name, address, identity: JSON.stringify([folded(city), folded(name), folded(address)]) });
    }
  }
  if (skipped) {
    c.partial = true;
    c.warnings.push('Cines Unidos returned venue records without a recognizable structure or name; the other venues are kept.');
    if (!records.length) throw new DataError('error', 'No venue could be recognized in the faulty Cines Unidos directory.');
  }
  const identities = new Map<string, Set<string>>();
  for (const r of records) {
    const set = identities.get(r.id) ?? new Set<string>(); set.add(r.identity); identities.set(r.id, set);
  }
  return records.map(r => {
    const verified = Id.safeParse(r.id).success && !r.id.startsWith('directory-') && identities.get(r.id)!.size === 1;
    if (!verified) {
      c.partial = true;
      c.warnings.push(`Query code missing, invalid or contradictory for ${r.name}; venue kept with its official link. This does not indicate a closure.`);
    }
    return { kind: 'cinema', id: verified ? r.id : `directory-cu-${createHash('sha256').update(r.identity).digest('hex').slice(0, 24)}`,
      name: r.name, city, address: r.address, url, code_status: verified ? 'verified' : 'unverified',
      ...(verified ? { cinema_id: r.id } : {}) };
  });
}
