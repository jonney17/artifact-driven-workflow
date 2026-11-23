import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { type Artifact, type ArtifactEnvelope, ArtifactEnvelopeSchema, type DerivedFrom } from '@sdlc/contracts';

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseArtifact(text: string, source = '<text>'): Artifact {
  const m = FRONT_MATTER.exec(text);
  if (!m) throw new Error(`${source}: missing front matter`);
  const envelope = ArtifactEnvelopeSchema.parse(parse(m[1] ?? ''));
  return { envelope, body: m[2] ?? '' };
}

export function serializeArtifact(a: Artifact): string {
  return `---\n${stringify(a.envelope).trimEnd()}\n---\n${a.body}`;
}

/** Content hash used in `derived_from`. Only the body counts, so a status change (e.g. approval) never makes dependents stale. */
export function hashBody(body: string): string {
  return 'sha256:' + createHash('sha256').update(body.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16);
}

export function pin(a: Artifact): DerivedFrom {
  return { id: a.envelope.id, version: a.envelope.version, hash: hashBody(a.body) };
}

export interface WriteArtifact {
  id: string;
  type: string;
  status: string;
  produced_by: string;
  story: string;
  repo?: string;
  derived_from?: DerivedFrom[];
  body: string;
}

/**
 * File-based artifact store under `<root>/stories/<KEY>/artifacts/<id>.md` (root = `.sdlc/work`).
 * It keeps the current version only; history lives in the workspace repo's git history.
 */
export class ArtifactStore {
  constructor(readonly root: string) {}

  storyDir(story: string): string {
    return join(this.root, 'stories', story);
  }

  private artifactsDir(story: string): string {
    return join(this.storyDir(story), 'artifacts');
  }

  async list(story: string): Promise<Artifact[]> {
    const dir = this.artifactsDir(story);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    const files = names.filter((n) => n.endsWith('.md')).sort();
    return Promise.all(files.map(async (f) => parseArtifact(await readFile(join(dir, f), 'utf8'), f)));
  }

  async get(story: string, id: string): Promise<Artifact | undefined> {
    try {
      return parseArtifact(await readFile(join(this.artifactsDir(story), `${id}.md`), 'utf8'), id);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
  }

  /** Writes an artifact. The version goes up only when the body changes. */
  async write(w: WriteArtifact): Promise<Artifact> {
    const existing = await this.get(w.story, w.id);
    const bodyChanged = !existing || hashBody(existing.body) !== hashBody(w.body);
    const envelope: ArtifactEnvelope = ArtifactEnvelopeSchema.parse({
      id: w.id,
      type: w.type,
      version: existing ? existing.envelope.version + (bodyChanged ? 1 : 0) : 1,
      status: w.status,
      produced_by: w.produced_by,
      story: w.story,
      ...(w.repo ? { repo: w.repo } : {}),
      derived_from: w.derived_from ?? [],
    });
    const artifact: Artifact = { envelope, body: w.body };
    await this.save(artifact);
    return artifact;
  }

  async setStatus(story: string, id: string, status: string): Promise<Artifact> {
    const a = await this.get(story, id);
    if (!a) throw new Error(`artifact ${id} not found in ${story}`);
    const updated: Artifact = { envelope: { ...a.envelope, status }, body: a.body };
    await this.save(updated);
    return updated;
  }

  private async save(a: Artifact): Promise<void> {
    const dir = this.artifactsDir(a.envelope.story);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${a.envelope.id}.md`), serializeArtifact(a), 'utf8');
  }
}
