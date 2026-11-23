import { z } from 'zod';

/** An input a contract consumes: an artifact type in one of the accepted statuses. */
export const ContractInputSchema = z.object({
  type: z.string().min(1),
  /** Statuses that satisfy the input. Defaults to ready or approved. */
  status: z.array(z.string()).default(['ready', 'approved']),
  /**
   * `story`: one artifact per story. `repo`: one per story × repo (matched to the instance's repo).
   * `any`: all artifacts of that type for the story (used by fan-in contracts such as QE (c)).
   */
  scope: z.enum(['story', 'repo', 'any']).default('story'),
  optional: z.boolean().default(false),
});
export type ContractInput = z.infer<typeof ContractInputSchema>;

/** A rework input (review, defect, red pipeline, rebase, answer) with its round limit. */
export const ReworkInputSchema = z.object({
  type: z.string().min(1),
  scope: z.enum(['story', 'repo']).default('repo'),
  /** Name of the `limits.*` overlay key holding the round limit, e.g. `review_rounds`. */
  limit: z.string().optional(),
});
export type ReworkInput = z.infer<typeof ReworkInputSchema>;

export const ContractOutputSchema = z.object({
  type: z.string().min(1),
  scope: z.enum(['story', 'repo']).default('story'),
  /** Markdown headings (## …) the body must contain, e.g. "Interfaces & test hooks". */
  required_sections: z.array(z.string()).default([]),
  /** Status the engine gives a valid output. */
  status: z.string().default('ready'),
});
export type ContractOutput = z.infer<typeof ContractOutputSchema>;

/** One agent contract of a pack (plan §2). Overlays may never change these fields. */
export const ContractSchema = z.object({
  id: z.string().min(1),
  agent: z.string().min(1),
  inputs: z.array(ContractInputSchema).default([]),
  rework_inputs: z.array(ReworkInputSchema).default([]),
  outputs: z.array(ContractOutputSchema).min(1),
  /** `repo`: one instance per affected repo of the story. */
  fan_out: z.enum(['none', 'repo']).default('none'),
  workdir: z.enum(['worktree', 'workspace']).default('worktree'),
  write_allow: z.array(z.string()).default([]),
  write_deny: z.array(z.string()).default([]),
  tools: z.array(z.string()).default([]),
  gate: z.string().nullable().default(null),
});
export type Contract = z.infer<typeof ContractSchema>;

/** Contract fields an overlay must never change: what an agent consumes or produces, and where it may write. */
export const PROTECTED_CONTRACT_FIELDS = [
  'inputs',
  'rework_inputs',
  'outputs',
  'fan_out',
  'workdir',
  'write_allow',
  'write_deny',
  'tools',
] as const;
