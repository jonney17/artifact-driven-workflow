import picomatch from 'picomatch';

export interface WriteScopeArgs {
  changedFiles: string[];
  writeAllow: string[];
  writeDeny: string[];
  /** `security.sensitive_paths` from the overlay. */
  sensitivePaths: string[];
  /** Paths the approved proposal lists under "Sensitive changes" (plan §5b). */
  unlocked: string[];
  /** Values for `${name}` placeholders in patterns, e.g. `test_dirs`. */
  vars?: Record<string, string[]>;
}

export interface ScopeViolation {
  path: string;
  reason: 'not in write_allow' | 'in write_deny' | 'sensitive path not listed in the proposal';
}

/** Expands `${name}` placeholders: `${test_dirs}/**` with test_dirs [e2e, src/acceptance] gives two patterns. */
export function expandPatterns(patterns: string[], vars: Record<string, string[]> = {}): string[] {
  return patterns.flatMap((p) => {
    const m = /\$\{(\w+)\}/.exec(p);
    if (!m) return [p];
    const values = vars[m[1] ?? ''] ?? [];
    return expandPatterns(values.map((v) => p.replace(m[0], v.replace(/\/+$/, ''))), vars);
  });
}

const matcher = (patterns: string[]) => (patterns.length ? picomatch(patterns, { dot: true }) : () => false);

const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');

/** Checks an attempt's changed files against its contract's write scope and the sensitive paths (plan §5b). */
export function checkWriteScope(args: WriteScopeArgs): ScopeViolation[] {
  const allow = matcher(expandPatterns(args.writeAllow, args.vars));
  const deny = matcher(expandPatterns(args.writeDeny, args.vars));
  const sensitive = matcher(args.sensitivePaths);
  const unlocked = matcher(args.unlocked.map(norm));
  const violations: ScopeViolation[] = [];
  for (const raw of args.changedFiles) {
    const path = norm(raw);
    if (deny(path)) violations.push({ path, reason: 'in write_deny' });
    else if (!allow(path)) violations.push({ path, reason: 'not in write_allow' });
    else if (sensitive(path) && !unlocked(path)) violations.push({ path, reason: 'sensitive path not listed in the proposal' });
  }
  return violations;
}

/**
 * Reads the paths listed in a proposal's "Sensitive changes" section: each bullet's first
 * `code span` is a path or glob. "none" (or an empty section) unlocks nothing.
 */
export function parseSensitiveChanges(proposalBody: string): string[] {
  const lines = proposalBody.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,6}\s+sensitive changes\s*$/i.test(l.trim()));
  if (start < 0) return [];
  const paths: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line.trim())) break;
    const m = /^\s*[-*]\s+`([^`]+)`/.exec(line);
    if (m?.[1]) paths.push(m[1]);
  }
  return paths;
}
