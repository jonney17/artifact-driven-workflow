import { readFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

/**
 * The developer's local config, `~/.sdlc/config.yaml` (or `$SDLC_CONFIG`). Never pushed: it holds
 * machine paths and the personal allowance. Credentials are NOT here; they come from the environment
 * (Phase 1) or the OS keychain (to wire in on the work machine).
 */
export const LocalConfigSchema = z.object({
  /** Local clone of the `<team>-sdlc-workspace` GitLab repo. */
  workspace: z.string(),
  /** This developer's email, as in team.yaml `members` and Jira. */
  user: z.string(),
  engine_id: z.string().optional(),
  /** AI credits per month on this developer's plan (Q2: 50,000); default from team.yaml. */
  monthly_allowance: z.number().positive().optional(),
  /** Repo name → local clone path (overrides team.yaml `repos.<name>.path`). */
  repos: z.record(z.string(), z.string()).default({}),
  worktrees: z.string().optional(),
  /** Where packs live; defaults to this engine's `packs/` folder. */
  packs_dir: z.string().optional(),
});
export type LocalConfig = z.infer<typeof LocalConfigSchema> & { engine_id: string; worktrees: string; home: string };

export const sdlcHome = () => process.env.SDLC_HOME ?? join(homedir(), '.sdlc');

export async function loadLocalConfig(path = process.env.SDLC_CONFIG ?? join(sdlcHome(), 'config.yaml')): Promise<LocalConfig> {
  let raw: unknown;
  try {
    raw = parse(await readFile(path, 'utf8'));
  } catch (e) {
    throw new Error(`can't read ${path}: create it with \`sdlc init\` (${(e as Error).message})`);
  }
  return withDefaults(LocalConfigSchema.parse(raw));
}

export function withDefaults(c: z.infer<typeof LocalConfigSchema>): LocalConfig {
  const home = sdlcHome();
  return {
    ...c,
    workspace: resolve(c.workspace),
    engine_id: c.engine_id ?? `${hostname()}-${c.user}`.replace(/[^\w.@-]/g, '_'),
    worktrees: resolve(c.worktrees ?? join(home, 'worktrees')),
    home,
  };
}

/** Expands `${VAR}` from the environment (e.g. `questions.notify.webhook: "${TEAMS_WEBHOOK}"`). */
export const expandEnv = (s: string, env: NodeJS.ProcessEnv = process.env) => s.replace(/\$\{(\w+)\}/g, (_, k: string) => env[k] ?? '');
