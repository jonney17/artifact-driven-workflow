import type { AttemptRequest } from './runner';
import { checkWriteScope } from './writescope';

/** A permission request from the agent runtime (Copilot's `onPermissionRequest`), normalised. */
export type PermissionRequest =
  | { kind: 'read'; path: string }
  | { kind: 'write'; path: string }
  | { kind: 'shell'; command: string }
  | { kind: 'url'; url: string }
  | { kind: 'mcp'; server: string; tool: string }
  | { kind: 'custom-tool'; name: string };

export interface PermissionDecision {
  allow: boolean;
  reason: string;
}

/** Tools the engine registers itself on every session; always allowed. */
export const ENGINE_TOOLS = ['ask_human'];

const firstWord = (cmd: string) => cmd.trim().split(/\s+/)[0] ?? '';

/** Splits a shell line into its simple commands (`a && b | c; d`), so a chained command can't sneak through. */
export function simpleCommands(line: string): string[] {
  return line
    .split(/&&|\|\||[|;&\n]|`|\$\(/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The engine's answer to every permission request (plan §5 "onPermissionRequest", §5b "Tools"):
 * - `read`: inside the worktree only;
 * - `write`: the contract's write scope and the sensitive-path rule;
 * - `shell`: only programs from the configured commands for this contract's `shell:*` tools, plus read-only git;
 * - `url`: only allowlisted hosts, and only if the contract has the `web` tool;
 * - MCP servers: never (no GitLab/Jira MCP for agents);
 * - custom tools: only the engine's own (`ask_human`).
 */
export function decidePermission(req: PermissionRequest, policy: AttemptRequest['policy'], workdir: string): PermissionDecision {
  const norm = (p: string) => p.replace(/\\/g, '/');
  const root = norm(workdir).replace(/\/+$/, '');
  const rel = (p: string) => {
    const n = norm(p);
    if (/^([a-z]:)?\//i.test(n)) return n.toLowerCase().startsWith(root.toLowerCase() + '/') ? n.slice(root.length + 1) : undefined;
    return n.split('/').includes('..') ? undefined : n.replace(/^\.\//, '');
  };
  switch (req.kind) {
    case 'read': {
      const r = rel(req.path);
      return r === undefined ? { allow: false, reason: 'outside the worktree' } : { allow: true, reason: 'read in worktree' };
    }
    case 'write': {
      if (!policy.tools.includes('edit')) return { allow: false, reason: 'this agent has no edit tool' };
      const r = rel(req.path);
      if (r === undefined) return { allow: false, reason: 'outside the worktree' };
      const v = checkWriteScope({
        changedFiles: [r],
        writeAllow: policy.writeAllow,
        writeDeny: policy.writeDeny,
        sensitivePaths: policy.sensitivePaths ?? [],
        unlocked: policy.unlocked ?? [],
        ...(policy.vars ? { vars: policy.vars } : {}),
      });
      return v.length ? { allow: false, reason: v[0]!.reason } : { allow: true, reason: 'in write scope' };
    }
    case 'shell': {
      const allowed = new Set(Object.values(policy.shellCommands ?? {}).flatMap((c) => simpleCommands(c).map(firstWord)));
      for (const cmd of simpleCommands(req.command)) {
        const prog = firstWord(cmd);
        const readOnlyGit = prog === 'git' && /^git\s+(status|diff|log|show|branch|rev-parse|ls-files|add|commit|restore|stash)\b/.test(cmd);
        if (!allowed.has(prog) && !readOnlyGit) return { allow: false, reason: `command ${prog} is not allowed for this contract` };
        if (prog === 'git' && /\b(push|remote|config|credential)\b/.test(cmd)) return { allow: false, reason: 'only the engine pushes' };
      }
      return { allow: true, reason: 'allowed command' };
    }
    case 'url': {
      if (!policy.tools.includes('web')) return { allow: false, reason: 'web is off for this contract' };
      let host: string;
      try {
        host = new URL(req.url).hostname;
      } catch {
        return { allow: false, reason: 'invalid url' };
      }
      return hostAllowed(host, policy.networkAllow ?? []) ? { allow: true, reason: 'allowlisted host' } : { allow: false, reason: `host ${host} not in the allowlist` };
    }
    case 'mcp':
      return { allow: false, reason: 'MCP servers are not available to agents' };
    case 'custom-tool':
      return ENGINE_TOOLS.includes(req.name) ? { allow: true, reason: 'engine tool' } : { allow: false, reason: `unknown tool ${req.name}` };
  }
}

/** Host allowlist with `*.example.com` wildcards. */
export function hostAllowed(host: string, allow: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return allow.some((raw) => {
    const p = raw.toLowerCase().trim();
    return p.startsWith('*.') ? h.endsWith(p.slice(1)) || h === p.slice(2) : h === p;
  });
}

/** Environment variables that may pass into an agent session. Everything else is dropped (no tokens). */
const PASS = [
  /^PATH$/i, /^PATHEXT$/i, /^HOME$/, /^USERPROFILE$/i, /^APPDATA$/i, /^LOCALAPPDATA$/i, /^PROGRAMDATA$/i, /^SYSTEMROOT$/i, /^WINDIR$/i,
  /^COMSPEC$/i, /^TEMP$/i, /^TMP$/i, /^TMPDIR$/, /^LANG$/, /^LC_/, /^TZ$/, /^TERM$/, /^SHELL$/, /^USER(NAME)?$/i,
  /^JAVA_HOME$/i, /^MAVEN_HOME$/i, /^M2_HOME$/i, /^NODE_OPTIONS$/, /^PNPM_HOME$/i, /^NVM_/i, /^PROCESSOR_/i, /^NUMBER_OF_PROCESSORS$/i, /^OS$/,
  /^XDG_(CONFIG|CACHE|DATA)_HOME$/,
];
const SECRET = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE|JIRA|GITLAB|ATLASSIAN|CONFLUENCE|AUTH/i;

/**
 * The stripped environment for an agent session (plan §5b "Secrets"): only an allowlist of harmless
 * variables, git credential helpers disabled, no terminal prompts, and the per-session proxy.
 * Copilot authenticates from its own stored login (to verify in the Copilot SDK spike).
 */
export function sessionEnv(source: NodeJS.ProcessEnv, opts: { proxyUrl?: string; extra?: Record<string, string> } = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v !== undefined && PASS.some((re) => re.test(k)) && !SECRET.test(k)) env[k] = v;
  }
  Object.assign(env, {
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GCM_INTERACTIVE: 'never',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
  });
  if (opts.proxyUrl) {
    const u = new URL(opts.proxyUrl);
    Object.assign(env, {
      HTTP_PROXY: opts.proxyUrl,
      HTTPS_PROXY: opts.proxyUrl,
      http_proxy: opts.proxyUrl,
      https_proxy: opts.proxyUrl,
      NO_PROXY: '',
      npm_config_proxy: opts.proxyUrl,
      npm_config_https_proxy: opts.proxyUrl,
      MAVEN_OPTS: `-Dhttp.proxyHost=${u.hostname} -Dhttp.proxyPort=${u.port} -Dhttps.proxyHost=${u.hostname} -Dhttps.proxyPort=${u.port}`,
      JAVA_TOOL_OPTIONS: `-Dhttp.proxyHost=${u.hostname} -Dhttp.proxyPort=${u.port} -Dhttps.proxyHost=${u.hostname} -Dhttps.proxyPort=${u.port}`,
    });
  }
  return { ...env, ...(opts.extra ?? {}) };
}
