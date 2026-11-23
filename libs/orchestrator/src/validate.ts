import type { ContractOutput } from '@sdlc/contracts';

export interface OutputIssue {
  type: string;
  message: string;
}

const hasHeading = (body: string, name: string) => {
  const want = name.trim().toLowerCase();
  return body.split(/\r?\n/).some((l) => {
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(l.trim());
    return m?.[1]?.toLowerCase() === want;
  });
};

/** Checks one output against its contract: non-empty body and every required section present. */
export function validateOutput(output: ContractOutput, body: string | undefined): OutputIssue[] {
  if (body === undefined) return [{ type: output.type, message: 'output not produced' }];
  if (!body.trim()) return [{ type: output.type, message: 'output is empty' }];
  return output.required_sections
    .filter((s) => !hasHeading(body, s))
    .map((s) => ({ type: output.type, message: `missing required section "${s}"` }));
}
