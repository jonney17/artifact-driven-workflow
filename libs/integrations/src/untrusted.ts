/**
 * Fences text that came from people outside the session (Jira, Confluence, MR comments) so an agent
 * reads it as data, not instructions (plan §5b). The fence is longer than any backtick run inside,
 * so the text can't close it early.
 */
export function fenceUntrusted(text: string, source: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}untrusted source=${source}\n${text.replace(/\r\n/g, '\n').trimEnd()}\n${fence}`;
}
