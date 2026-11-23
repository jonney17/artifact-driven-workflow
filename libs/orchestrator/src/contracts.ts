import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { type Contract, ContractSchema } from '@sdlc/contracts';

export const StatusRuleSchema = z.object({
  status: z.string(),
  when: z.array(
    z.object({
      type: z.string(),
      status: z.array(z.string()).optional(),
      /** Every affected repo must have a matching artifact. */
      every_repo: z.boolean().default(false),
    }),
  ),
});
export type StatusRule = z.infer<typeof StatusRuleSchema>;

const PackMetaSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/),
  version: z.number().int().positive(),
  description: z.string().optional(),
  agents: z.record(z.string(), z.object({ prompt: z.string() })).default({}),
  jira_status: z.array(StatusRuleSchema).default([]),
  coach: z.record(z.string(), z.record(z.string(), z.string())).default({}),
});

export interface Pack {
  name: string;
  major: number;
  contracts: Contract[];
  /** Agent name → base prompt path, relative to `dir`. */
  agents?: Record<string, { prompt: string }>;
  jiraStatus?: StatusRule[];
  /** The pack directory, when loaded from disk (prompts and templates live there). */
  dir?: string;
}

/** Parses contracts and checks that ids are unique. */
export function parseContracts(raw: unknown[]): Contract[] {
  const contracts = raw.map((r) => ContractSchema.parse(r));
  const seen = new Set<string>();
  for (const c of contracts) {
    if (seen.has(c.id)) throw new Error(`duplicate contract id: ${c.id}`);
    seen.add(c.id);
  }
  return contracts;
}

/** Loads a pack directory: `pack.yaml` and `contracts/*.yaml` (in file-name order). */
export async function loadPack(dir: string): Promise<Pack> {
  const meta = PackMetaSchema.parse(parse(await readFile(join(dir, 'pack.yaml'), 'utf8')));
  const files = (await readdir(join(dir, 'contracts'))).filter((f) => /\.ya?ml$/.test(f)).sort();
  const raw = await Promise.all(files.map(async (f) => parse(await readFile(join(dir, 'contracts', f), 'utf8'))));
  const contracts = parseContracts(raw);
  for (const c of contracts) {
    if (Object.keys(meta.agents).length && !meta.agents[c.agent]) throw new Error(`contract ${c.id}: agent ${c.agent} is not declared in pack.yaml`);
  }
  return { name: meta.name, major: meta.version, contracts, agents: meta.agents, jiraStatus: meta.jira_status, dir };
}
