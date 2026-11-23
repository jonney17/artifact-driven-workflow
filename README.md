# Artifact-driven agentic SDLC workflow

This repo holds the design docs for a contract-driven agentic SDLC workflow on GitHub Copilot, for a SAFe Scrum team.

- **Phase 1 plan (approved 2026-11-23):** [docs/plan/phase-1-plan.md](docs/plan/phase-1-plan.md). It was exported from [the plan artifact](https://claude.ai/artifact/83GxALqBhdCwSoNymSY2Bi), version `1795250480-83d2`, on 2026-11-21, and is the source of truth from here on. Accepted review items are applied to it (all review gaps G1–G12 applied on 2026-11-21; team answers applied 2026-11-23; open team questions are in its §13). Open proposals are in [review-notes.md](docs/plan/review-notes.md).
- **Build status and next tasks:** [docs/build/HANDOFF.md](docs/build/HANDOFF.md).
- **Workflow reference** (for people and AI improving the workflow): [docs/workflow/WORKFLOW.md](docs/workflow/WORKFLOW.md). AI tools start at [AGENTS.md](AGENTS.md).

## Engine

This repo is also the `sdlc-engine` Nx monorepo from plan §9. Plan steps 2–8 are built and tested against fakes. What still needs the real Copilot, Jira and GitLab is listed in [docs/build/HANDOFF.md](docs/build/HANDOFF.md) §5.

```sh
corepack enable && pnpm install
pnpm typecheck && pnpm test
pnpm --filter @sdlc/web build && pnpm --filter @sdlc/cli build
node apps/cli/dist/sdlc.mjs demo --serve   # one story from Jira to Done on fakes, then the UI on http://127.0.0.1:7317
```

Layout: `libs/` (contracts, runtimes, orchestrator, integrations, hostgen, retro, app), `apps/` (cli, server, web), `packs/safe-scrum`, `examples/overlays`, `skills/sdlc`. Details: [HANDOFF.md](docs/build/HANDOFF.md) §3.
