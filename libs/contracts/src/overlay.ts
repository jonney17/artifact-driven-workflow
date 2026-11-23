import { z } from 'zod';

/**
 * Per-agent overlay settings: how an agent works, never what it consumes or produces (plan §1).
 * `.strict()` makes an attempt to set `inputs`, `outputs`, `write_allow`… a validation error.
 */
export const AgentOverlaySchema = z
  .object({
    model: z.string().optional(),
    fallback_model: z.string().optional(),
    enabled: z.boolean().optional(),
    instructions: z.string().optional(),
    skills: z.array(z.string()).optional(),
    max_turns_per_session: z.number().int().positive().optional(),
    gate_mode: z.enum(['human', 'auto']).optional(),
  })
  .strict();
export type AgentOverlay = z.infer<typeof AgentOverlaySchema>;

export const LimitsSchema = z
  .object({
    review_rounds: z.number().int().nonnegative().default(2),
    defect_rounds: z.number().int().nonnegative().default(3),
    concurrency: z.number().int().positive().default(2),
    ai_credits_per_story: z.number().positive().default(4000),
    max_turns_per_session: z.number().int().positive().default(60),
  })
  .catchall(z.number());
export type Limits = z.infer<typeof LimitsSchema>;

export const RuntimeSchema = z.object({
  mode: z.enum(['local', 'team_host']).default('local'),
  owner: z.enum(['assignee', 'all']).default('assignee'),
  workspace_repo: z.string().optional(),
  lease_ttl_minutes: z.number().positive().default(30),
  poll: z
    .object({ jira_seconds: z.number().positive().default(120), gitlab_seconds: z.number().positive().default(60) })
    .default({ jira_seconds: 120, gitlab_seconds: 60 }),
});

export const RepoSchema = z
  .object({
    path: z.string(),
    gitlab_project: z.string().optional(),
    branch: z.string().default('main'),
    test_dirs: z.array(z.string()).default([]),
  })
  .catchall(z.unknown());
export type RepoConfig = z.infer<typeof RepoSchema>;

export const SecuritySchema = z.object({
  isolation: z.enum(['process', 'container']).default('process'),
  untrusted_fencing: z.boolean().default(true),
  sensitive_paths: z.array(z.string()).default([]),
  network: z
    .object({ mode: z.enum(['allowlist', 'off']).default('allowlist'), allow: z.array(z.string()).default([]) })
    .default({ mode: 'allowlist', allow: [] }),
});

/**
 * The parts of `.sdlc/team/team.yaml` the engine core reads. Integration sections (jira, gitlab,
 * confluence, …) pass through unvalidated here and are validated by their own libs.
 */
export const TeamOverlaySchema = z
  .object({
    pack: z.string().regex(/^[a-z0-9-]+@\d+$/, 'pack must look like name@major'),
    team: z.string().min(1),
    repos: z.record(z.string(), RepoSchema).default({}),
    limits: LimitsSchema.default(LimitsSchema.parse({})),
    gates: z.record(z.string(), z.enum(['human', 'auto'])).default({}),
    runtime: RuntimeSchema.default(RuntimeSchema.parse({})),
    security: SecuritySchema.default(SecuritySchema.parse({})),
    agents: z.record(z.string(), AgentOverlaySchema).default({}),
  })
  .catchall(z.unknown());
export type TeamOverlay = z.infer<typeof TeamOverlaySchema>;
