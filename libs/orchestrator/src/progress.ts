import type { Artifact } from '@sdlc/contracts';
import type { StatusRule } from './contracts';

/**
 * The story's workflow status (a `jira.status_map` key) from its artifacts, using the pack's
 * `jira_status` rules: the first rule whose conditions all hold wins (plan §3 "Outbound").
 */
export function storyStatus(artifacts: Artifact[], repos: string[], rules: StatusRule[]): string | undefined {
  const live = artifacts.filter((a) => a.envelope.status !== 'cancelled');
  for (const rule of rules) {
    const ok = rule.when.every((w) => {
      const matches = live.filter((a) => a.envelope.type === w.type && (!w.status || w.status.includes(a.envelope.status)));
      if (!w.every_repo) return matches.length > 0;
      return repos.length > 0 && repos.every((r) => matches.some((a) => a.envelope.repo === r));
    });
    if (ok) return rule.status;
  }
  return undefined;
}

/** Affected repos of a story: from the Planner's per-repo proposals, else the given hints. */
export function storyRepos(artifacts: Artifact[], hints: string[] = []): string[] {
  const fromProposals = [...new Set(artifacts.filter((a) => a.envelope.type === 'proposal' && a.envelope.repo && a.envelope.status !== 'cancelled').map((a) => a.envelope.repo!))];
  return (fromProposals.length ? fromProposals : hints).sort();
}
