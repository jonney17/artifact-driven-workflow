# AGENTS.md

This repo holds the design of a reusable, artifact-driven agentic SDLC workflow for a SAFe Scrum team on GitHub Copilot. There is no code yet.

## Files

- [docs/workflow/WORKFLOW.md](docs/workflow/WORKFLOW.md): **the reference for any task that analyses or improves the workflow.** It covers the agents, artifacts, flow, gates, metrics, self-improvement loop, invariants and decision log.
- [docs/plan/phase-1-plan.md](docs/plan/phase-1-plan.md): the Phase 1 build plan (status: awaiting approval). It was exported from the source artifact and now includes the accepted review items.
- [docs/plan/review-notes.md](docs/plan/review-notes.md): open review findings and proposals (G1–G12) on the plan.

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
