# AGENTS.md

This repo holds the design and the engine code of a reusable, artifact-driven agentic SDLC workflow for a SAFe Scrum team on GitHub Copilot.

## If you are asked to "continue building the workflow"

Read **[docs/build/HANDOFF.md](docs/build/HANDOFF.md)** first and follow its protocol. It says where the build stands, how the code is organised, what to do next, and how to finish a task (checks, status update, commit).

## Files

- [docs/build/HANDOFF.md](docs/build/HANDOFF.md): **build status and next tasks** for the engine code (`libs/`, later `apps/` and `packs/`).
- [docs/plan/phase-1-plan.md](docs/plan/phase-1-plan.md): the Phase 1 build plan (approved 2026-11-23). It was exported from the source artifact and now includes the accepted review items and the team's answers (§13).
- [docs/workflow/WORKFLOW.md](docs/workflow/WORKFLOW.md): **the reference for any task that analyses or improves the workflow.** It covers the agents, artifacts, flow, gates, metrics, self-improvement loop, invariants and decision log.
- [docs/plan/review-notes.md](docs/plan/review-notes.md): the review findings G1–G12 and their decisions.

## Rules for all work

- Never give an agent session credentials. Never let agents call Jira, Confluence or GitLab; only the engine does. Don't use the GitLab MCP server in engine code.
- Don't commit to `main` directly; use a `feat/…` branch.
- `pnpm typecheck` and `pnpm test` must pass before a commit.

## Rules for workflow-improvement work

1. Read WORKFLOW.md §11 "How to change the workflow", §12 "Invariants" and §13 "Decision log" before proposing a change.
2. Back every proposal with evidence: session retros, metrics, story or session ids.
3. Fix at the lowest layer that works: team overlay, then pack, then engine.
4. Don't break an invariant or reverse a logged decision silently. If a proposal does either, say so explicitly.
5. When a change is accepted:
    - update the affected WORKFLOW.md section and remove its "(proposed)" label;
    - add a Decision log entry;
    - mark the item decided in review-notes.md;
    - update phase-1-plan.md when the plan itself changes.
