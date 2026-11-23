# Artifact-driven agentic SDLC workflow

This repo holds the design docs for a contract-driven agentic SDLC workflow on GitHub Copilot, for a SAFe Scrum team.

- **Phase 1 plan (approved 2026-11-23):** [docs/plan/phase-1-plan.md](docs/plan/phase-1-plan.md). It was exported from [the plan artifact](https://claude.ai/artifact/83GxALqBhdCwSoNymSY2Bi), version `1795250480-83d2`, on 2026-11-21, and is the source of truth from here on. Accepted review items are applied to it (all review gaps G1–G12 applied on 2026-11-21; team answers applied 2026-11-23; open team questions are in its §13). Open proposals are in [review-notes.md](docs/plan/review-notes.md).
- **Build status and next tasks:** [docs/build/HANDOFF.md](docs/build/HANDOFF.md).
- **Workflow reference** (for people and AI improving the workflow): [docs/workflow/WORKFLOW.md](docs/workflow/WORKFLOW.md). AI tools start at [AGENTS.md](AGENTS.md).

## Engine (in progress)

This repo is also the `sdlc-engine` Nx monorepo from plan §9 (TypeScript, Node ≥ 22, pnpm).

| Package | What it holds | Plan |
| --- | --- | --- |
| [libs/contracts](libs/contracts) | Zod schemas: artifact envelope, pack contracts, `team.yaml` overlay, `events.log` events, leases | §1, §2 |
| [libs/runtimes](libs/runtimes) | `Runner` interface and the stub runner used in tests (the Copilot SDK runner comes in build step 5) | §5 |
| [libs/orchestrator](libs/orchestrator) | Engine core: artifact store, staleness cascade, overlay resolve, make-like trigger, write-scope check, output validation, `events.log` and restart recovery, git-backed story/team leases, the engine tick | §2, §10 step 2 |

```sh
corepack enable        # provides pnpm (pinned in package.json)
pnpm install
pnpm typecheck
pnpm test              # unit tests; the lease tests use real local git repos
```
