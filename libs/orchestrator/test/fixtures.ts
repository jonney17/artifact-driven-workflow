import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseContracts, type Pack } from '../src/contracts';
import { resolveWorkflow } from '../src/resolve';

/** A small pack shaped like safe-scrum: planner → developer (per repo) → reviewer (per repo) → qe-run (fan-in). */
export function testPack(): Pack {
  return {
    name: 'test-pack',
    major: 1,
    contracts: parseContracts([
      {
        id: 'planner',
        agent: 'planner',
        inputs: [{ type: 'story' }],
        outputs: [{ type: 'proposal', required_sections: ['Interfaces & test hooks', 'Sensitive changes'] }],
        write_allow: ['.team/changes/**'],
        gate: 'proposal_approval',
      },
      {
        id: 'developer',
        agent: 'developer',
        fan_out: 'repo',
        inputs: [{ type: 'proposal', status: ['approved'] }],
        rework_inputs: [
          { type: 'review', limit: 'review_rounds' },
          { type: 'defect', limit: 'defect_rounds' },
        ],
        outputs: [{ type: 'code', scope: 'repo' }],
        write_allow: ['**'],
        write_deny: ['${test_dirs}/**', '.sdlc/**'],
      },
      {
        id: 'reviewer',
        agent: 'reviewer',
        fan_out: 'repo',
        inputs: [{ type: 'code', scope: 'repo' }],
        outputs: [{ type: 'review-report', scope: 'repo' }],
      },
      {
        id: 'qe-run',
        agent: 'qe',
        inputs: [{ type: 'code', scope: 'any' }],
        outputs: [{ type: 'acceptance' }],
        write_allow: ['${test_dirs}/**'],
      },
    ]),
  };
}

export const baseOverlay = () => ({
  pack: 'test-pack@1',
  team: 'test-team',
  repos: {
    api: { path: '../api', test_dirs: ['src/acceptance'] },
    web: { path: '../web', test_dirs: ['e2e'] },
  },
  limits: { review_rounds: 2, defect_rounds: 3, concurrency: 4 },
  security: { sensitive_paths: ['**/package.json', '.gitlab-ci.yml'] },
});

export const testWorkflow = (overlay: object = baseOverlay()) => resolveWorkflow(testPack(), overlay);

export const tempDir = (prefix = 'sdlc-') => mkdtemp(join(tmpdir(), prefix));

export const PROPOSAL = `# Proposal

## Interfaces & test hooks
- POST /invoices

## Sensitive changes
- \`package.json\` add a date library
`;
