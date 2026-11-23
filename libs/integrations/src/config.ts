import { z } from 'zod';

/** `team.yaml` → `jira` (plan §1, §3). */
export const JiraConfigSchema = z.object({
  site: z.string().url(),
  project: z.string().min(1),
  intake_jql: z.string().min(1),
  fields: z
    .object({
      acceptance_criteria: z.string().default('Acceptance Criteria'),
      topic: z.string().default('Epic Link'),
      repos: z.string().optional(),
      sprint: z.string().default('Sprint'),
    })
    .default({ acceptance_criteria: 'Acceptance Criteria', topic: 'Epic Link', sprint: 'Sprint' }),
  status_map: z
    .object({
      refining: z.string(),
      in_progress: z.string(),
      in_review: z.string(),
      in_qa: z.string(),
      ready_for_acceptance: z.string(),
      done: z.string(),
    })
    .partial()
    .default({}),
  gates_from_jira: z
    .object({
      story_acceptance: z.object({ transition: z.string() }).optional(),
      scenario_approval: z.object({ comment_command: z.string(), role: z.string() }).optional(),
    })
    .default({}),
  defects: z
    .object({ mode: z.enum(['subtask', 'linked_bug', 'comment']).default('subtask'), issuetype: z.string().default('Sub-bug') })
    .default({ mode: 'subtask', issuetype: 'Sub-bug' }),
  post_questions_as_comments: z.boolean().default(true),
});
export type JiraConfig = z.infer<typeof JiraConfigSchema>;

export const ConfluenceConfigSchema = z.object({
  site: z.string().url(),
  prd_link: z
    .object({ from: z.enum(['epic', 'story']).default('epic'), issue_link: z.string().default('mentioned in') })
    .default({ from: 'epic', issue_link: 'mentioned in' }),
});
export type ConfluenceConfig = z.infer<typeof ConfluenceConfigSchema>;

export const GitLabConfigSchema = z.object({
  url: z.string().url(),
  token_ref: z.string().default('GITLAB_TOKEN'),
  mr: z
    .object({
      draft_until: z.enum(['qe_pass', 'review_pass']).default('qe_pass'),
      labels: z.array(z.string()).default(['sdlc']),
      reviewer_starts_on: z.enum(['pipeline_success', 'mr_opened']).default('pipeline_success'),
      jira_dev_panel: z.boolean().default(false),
    })
    .default({ draft_until: 'qe_pass', labels: ['sdlc'], reviewer_starts_on: 'pipeline_success', jira_dev_panel: false }),
});
export type GitLabConfig = z.infer<typeof GitLabConfigSchema>;

export const LifecycleConfigSchema = z
  .object({
    in_flight_after: z.string().default('planner'),
    carry_over: z.enum(['keep_in_flight', 'hold']).default('keep_in_flight'),
    split: z
      .object({
        link_field: z.string().default('Linked Issues'),
        link_type: z.string().default('split from'),
        also_comment: z.boolean().default(true),
        reference_inputs: z.boolean().default(true),
      })
      .default({ link_field: 'Linked Issues', link_type: 'split from', also_comment: true, reference_inputs: true }),
    cancel: z
      .object({
        statuses: z.array(z.string()).default(['Cancelled']),
        resolutions: z.array(z.string()).default(["Won't Do"]),
        mrs: z.enum(['close', 'keep']).default('close'),
        branches: z.enum(['keep', 'delete']).default('keep'),
      })
      .default({ statuses: ['Cancelled'], resolutions: ["Won't Do"], mrs: 'close', branches: 'keep' }),
    reopened: z.enum(['defect']).default('defect'),
    retention: z.object({ paused_days: z.number().default(14) }).default({ paused_days: 14 }),
  });
export type LifecycleConfig = z.infer<typeof LifecycleConfigSchema>;

/** `members`: email → roles (plan §1). Gates and answers are checked against it. */
export const MembersSchema = z.record(z.string(), z.array(z.enum(['po', 'dev', 'qe', 'sm'])));
export type Members = z.infer<typeof MembersSchema>;

export const hasRole = (members: Members, who: string | undefined, role: string) =>
  !!who && (members[who] ?? members[who.toLowerCase()] ?? []).includes(role as never);
