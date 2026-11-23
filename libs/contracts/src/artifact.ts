import { z } from 'zod';

/** One input an artifact was derived from, pinned by version and content hash (plan §2). */
export const DerivedFromSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  hash: z.string().min(1),
});
export type DerivedFrom = z.infer<typeof DerivedFromSchema>;

/**
 * Artifact envelope: the YAML front matter of every artifact file (plan §2).
 * `story` and `repo` are explicit so the store can index artifacts without parsing ids.
 */
export const ArtifactEnvelopeSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  version: z.number().int().positive(),
  status: z.string().min(1),
  produced_by: z.string().min(1),
  story: z.string().min(1),
  repo: z.string().min(1).optional(),
  derived_from: z.array(DerivedFromSchema).default([]),
});
export type ArtifactEnvelope = z.infer<typeof ArtifactEnvelopeSchema>;

export interface Artifact {
  envelope: ArtifactEnvelope;
  /** Markdown body after the front matter. */
  body: string;
}

/** Statuses the engine itself relies on. Packs may use others for their own types. */
export const ArtifactStatus = {
  draft: 'draft',
  ready: 'ready',
  approved: 'approved',
  rejected: 'rejected',
  cancelled: 'cancelled',
  /** A rework input (review, defect, answer…) that no attempt has consumed yet. */
  open: 'open',
  consumed: 'consumed',
} as const;

/** Artifact id convention: `<type>-<story>` or `<type>-<story>-<repo>`. */
export function artifactId(type: string, story: string, repo?: string): string {
  return repo ? `${type}-${story}-${repo}` : `${type}-${story}`;
}
