import type { Artifact, ContractOutput } from '@sdlc/contracts';
import type { AttemptRequest } from '../runner';

export const OUT_DIR = '.sdlc-out';

/** File an output is written to: `.sdlc-out/<type>.md`, or `<type>--<repo>.md` for a per-repo output of a story-level step. */
export function outputFile(type: string, repo?: string): string {
  return repo ? `${OUT_DIR}/${type}--${repo}.md` : `${OUT_DIR}/${type}.md`;
}

const artifactBlock = (a: Artifact) => `### ${a.envelope.id} (${a.envelope.type} v${a.envelope.version}, ${a.envelope.status})\n\n${a.body.trim()}\n`;

/**
 * The first message of a session. Persona and rules come from the generated custom agent
 * (`sdlc-<agent>.agent.md`); this message carries the attempt's inputs and the output contract.
 * Inputs are artifacts only, never another agent's transcript (plan §2).
 */
export function buildPrompt(req: AttemptRequest, outputs: ContractOutput[], extras: { templates: Record<string, string>; decisions?: string; repos?: string[] }): string {
  const where = req.repo ? ` in repo \`${req.repo}\`` : '';
  const lines: string[] = [
    `You are running step \`${req.contractId}\` for story ${req.story}${where}, attempt ${req.attempt}.`,
    '',
    '## Inputs',
    '',
    ...(req.inputs.length ? req.inputs.map(artifactBlock) : ['(none)']),
  ];
  if (req.reworkInputs.length) lines.push('## Rework to address in this attempt', '', ...req.reworkInputs.map(artifactBlock));
  if (extras.decisions?.trim()) lines.push('## Decisions and answers so far', '', extras.decisions.trim(), '');
  if (req.policy.environmentUrl) lines.push('## Environment', '', `The engine started the environment for you. Base URL: ${req.policy.environmentUrl}`, '');
  const cmds = Object.entries(req.policy.shellCommands ?? {});
  if (cmds.length) lines.push('## Commands you may run', '', ...cmds.map(([k, v]) => `- ${k}: \`${v}\``), '');

  lines.push('## Outputs to produce', '', `Write each output as a Markdown file under \`${OUT_DIR}/\` in your working directory. Use the template and keep every required heading.`, '');
  for (const o of outputs) {
    const perRepo = o.scope === 'repo' && !req.repo;
    const file = perRepo ? outputFile(o.type, '<repo>') : outputFile(o.type);
    const flags = [o.optional ? 'optional' : 'required', o.multiple || o.numbered ? 'one file per item' : undefined, perRepo ? `one per affected repo${extras.repos?.length ? ` (${extras.repos.join(', ')})` : ''}` : undefined]
      .filter(Boolean)
      .join(', ');
    lines.push(`### \`${o.type}\` → \`${o.numbered ? file.replace(/\.md$/, '--<n>.md') : file}\` (${flags})`, '');
    if (o.required_sections.length) lines.push(`Required sections: ${o.required_sections.map((s) => `"${s}"`).join(', ')}.`);
    if (o.verdicts) lines.push(`Include a line \`Verdict: <${Object.keys(o.verdicts).join(' | ')}>\`.`);
    const t = extras.templates[o.type];
    if (t) lines.push('', 'Template:', '', '````markdown', t.trim(), '````');
    lines.push('');
  }
  lines.push('When you are done, stop. Don\'t push, open merge requests or update Jira: the engine does that.');
  return lines.join('\n');
}
