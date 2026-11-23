---
name: sdlc
description: Drive the team's agentic SDLC engine from chat - see the Board and your inbox, pass gates, answer questions, take over or hand back a step, check AI credits. Use when the user asks about story progress, approvals, agent questions or the sdlc engine.
---

# /sdlc

The `sdlc` CLI runs on the developer's own machine (Phase 1, local mode). Every command reads the
workspace repo; commands that change something push the story's state right away.

| The user wants to… | Run |
| --- | --- |
| see all their stories | `sdlc status` |
| see one story (steps, gates, questions, credits) | `sdlc status <KEY>` |
| know what needs them | `sdlc inbox` |
| read an artifact (proposal, review, acceptance pack…) | `sdlc show <KEY> <artifact-id>` |
| approve a proposal / scenarios / acceptance | `sdlc approve <KEY> <artifact-id>` (role-checked: dev, qe, po) |
| reject with feedback | `sdlc reject <KEY> <artifact-id> --reason "<feedback>"` |
| answer an agent's question | `sdlc questions`, then `sdlc answer <KEY> <Q-n> <answer>` |
| take a step away from the agents | `sdlc takeover <KEY> <repo> --step develop --reason <stuck\|wrong-approach\|delicate-change\|faster-by-hand\|other> --note "<why>"` |
| give it back | `sdlc handback <KEY> <repo> --at <develop\|review\|qe>` |
| check or raise AI credits | `sdlc budget`, `sdlc budget raise <KEY> <n>` |
| see what happened | `sdlc log <KEY>` |
| run the engine | `sdlc run` (or `sdlc run --once`, `sdlc run --dry-run`) |

Rules:
- Never approve, reject or answer on the user's behalf without them saying so explicitly: gates and answers are human decisions.
- Requirement answers belong in Jira or the PRD too: suggest the PO updates the story, so the change flows to every agent.
- Don't edit files under `.sdlc/work/`; use the commands.
