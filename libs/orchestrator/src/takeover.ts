import { artifactId } from '@sdlc/contracts';
import type { EventLog } from './recovery';
import { replay } from './recovery';
import type { ArtifactStore } from './store';
import { pin } from './store';
import { instanceKey } from './trigger';

export const TAKEOVER_REASONS = ['stuck', 'wrong-approach', 'delicate-change', 'faster-by-hand', 'other'] as const;
export type TakeoverReason = (typeof TAKEOVER_REASONS)[number];
export type TakeoverStep = 'develop' | 'planner' | 'qe-write' | 'qe-run';
export type HandbackAt = 'develop' | 'review' | 'qe' | 'gate' | 'qe-write' | 'done' | 'judge';

/** Which agent instances a takeover stops (plan §6a table). */
export function takeoverInstances(story: string, repo: string | undefined, step: TakeoverStep): string[] {
  switch (step) {
    case 'develop':
      if (!repo) throw new Error('develop takeover needs a repo');
      return [instanceKey('developer', story, repo), instanceKey('reviewer', story, repo)];
    case 'planner':
      return [instanceKey('planner', story)];
    case 'qe-write':
      if (!repo) throw new Error('qe-write takeover needs a repo');
      return [instanceKey('qe-write', story, repo)];
    case 'qe-run':
      return [instanceKey('qe-run', story)];
  }
}

const ALLOWED_AT: Record<TakeoverStep, HandbackAt[]> = {
  develop: ['develop', 'review', 'qe'],
  planner: ['gate'],
  'qe-write': ['qe-write', 'done'],
  'qe-run': ['judge'],
};

/**
 * Human takeover and handback (plan §6a). The story keeps its owner, lease and Jira status; only the
 * agents of that step stop. A reason is required and becomes a Coach signal.
 */
export class Takeovers {
  constructor(
    private readonly store: ArtifactStore,
    private readonly events: EventLog,
  ) {}

  async takeover(a: { story: string; repo?: string; step: TakeoverStep; reason: TakeoverReason; note: string; by: string }): Promise<string[]> {
    if (!TAKEOVER_REASONS.includes(a.reason)) throw new Error(`reason must be one of ${TAKEOVER_REASONS.join(', ')}`);
    if (!a.note.trim()) throw new Error('a short note is required');
    const instances = takeoverInstances(a.story, a.repo, a.step);
    for (const instance of instances) {
      await this.events.append({ story: a.story, type: 'takeover.started', instance, data: { step: a.step, reason: a.reason, note: a.note, by: a.by, ...(a.repo ? { repo: a.repo } : {}) } });
    }
    return instances;
  }

  /**
   * Hands a step back to the agents at a chosen stage, after checking the contract still holds.
   * For `review`/`qe` the human's code becomes the `code` artifact (it needs `mr-description` to exist);
   * for `qe` the human review counts as approved; for `gate` the hand-written proposal goes to the gate.
   */
  async handback(a: { story: string; repo?: string; step: TakeoverStep; at: HandbackAt; by: string; summary?: string }): Promise<void> {
    if (!ALLOWED_AT[a.step].includes(a.at)) throw new Error(`--at ${a.at} isn't valid for a ${a.step} takeover (use ${ALLOWED_AT[a.step].join(', ')})`);
    const state = replay(await this.events.read(a.story));
    const instances = takeoverInstances(a.story, a.repo, a.step);
    const active = state.takenOver === 'story' || instances.some((i) => (state.takenOver as Set<string>).has(i));
    if (!active) throw new Error(`no ${a.step} takeover is active for ${a.story}${a.repo ? ` ${a.repo}` : ''}`);
    const all = await this.store.list(a.story);
    const by = `human:${a.by}`;
    const proposal = all.find((x) => x.envelope.type === 'proposal' && x.envelope.repo === a.repo);

    if (a.step === 'develop' && (a.at === 'review' || a.at === 'qe')) {
      if (!all.some((x) => x.envelope.id === artifactId('mr-description', a.story, a.repo))) {
        throw new Error('mr-description is missing: write it (or hand back at develop so the Developer agent writes only the description)');
      }
      const code = await this.store.write({
        id: artifactId('code', a.story, a.repo),
        type: 'code',
        status: 'ready',
        produced_by: by,
        story: a.story,
        ...(a.repo ? { repo: a.repo } : {}),
        derived_from: proposal ? [pin(proposal)] : [],
        body: `# Code: ${a.story} in ${a.repo}\n\n## Summary\n\n${a.summary ?? 'Written by a human (takeover).'}\n\n## Changes\n\nSee the branch ${a.story}/${a.repo}.\n\n## Self-check\n\nBy the responsible dev.\n`,
      });
      if (a.at === 'qe') {
        await this.store.write({
          id: artifactId('review', a.story, a.repo),
          type: 'review',
          status: 'approved',
          produced_by: by,
          story: a.story,
          ...(a.repo ? { repo: a.repo } : {}),
          derived_from: [pin(code)],
          body: `# Review: ${a.story} in ${a.repo}\n\nVerdict: approved\n\n## Findings\n\nAgent review skipped at handback; humans review in the MR.\n`,
        });
      }
    }
    if (a.step === 'qe-write' && a.at === 'done') {
      await this.store.write({
        id: artifactId('test-code', a.story, a.repo),
        type: 'test-code',
        status: 'ready',
        produced_by: by,
        story: a.story,
        ...(a.repo ? { repo: a.repo } : {}),
        body: `# Test code: ${a.story} in ${a.repo}\n\n## Tests written\n\nBy a human QE (takeover).\n\n## Dry run\n\nn/a\n`,
      });
    }
    if (a.step === 'planner' && a.at === 'gate' && !all.some((x) => x.envelope.type === 'proposal')) {
      throw new Error('no proposal found: write the proposal before handing back to the gate');
    }
    for (const instance of instances) await this.events.append({ story: a.story, type: 'takeover.ended', instance, data: { at: a.at, by: a.by } });
  }
}
