import type { Artifact } from '@sdlc/contracts';
import { hashBody } from './store';

/**
 * Ids of stale artifacts. An artifact is stale when an input it was derived from is missing, has a
 * newer version or a different hash, or is itself stale (the cascade, plan §2).
 * Cancelled artifacts are ignored.
 */
export function findStale(artifacts: Artifact[]): Set<string> {
  const byId = new Map(artifacts.map((a) => [a.envelope.id, a]));
  const stale = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const a of artifacts) {
      const id = a.envelope.id;
      if (stale.has(id) || a.envelope.status === 'cancelled') continue;
      const isStale = a.envelope.derived_from.some((d) => {
        const cur = byId.get(d.id);
        return !cur || cur.envelope.version !== d.version || hashBody(cur.body) !== d.hash || stale.has(d.id);
      });
      if (isStale) {
        stale.add(id);
        changed = true;
      }
    }
  }
  return stale;
}
