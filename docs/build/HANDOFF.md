# Build handoff: continue building the workflow engine

Read this file first when asked to **"continue building the workflow"**. It says where the build stands, how the code is organised, and exactly what to do next. Keep it up to date: it is the only memory the next session (human or AI) has.

- **What we build:** the Phase 1 engine from [phase-1-plan.md](../plan/phase-1-plan.md) (status: approved 2026-11-23).
- **Build order:** plan §10. **Tests to pass:** plan §11. **Rules that must hold:** [WORKFLOW.md](../workflow/WORKFLOW.md) §12 "Invariants".
- **Last updated:** 2026-11-23, after build step 2 (engine core).

## 1. The protocol for "continue building the workflow"

1. Run the checks in §2 and make sure they pass before changing anything. If they fail, fix that first.
2. Open §4 "Build status" below and take the **first task that isn't done**. Don't skip ahead; later steps rely on earlier ones.
3. Read the plan sections that task names, and the §11 verification bullets for it. The tests you write come from those bullets.
4. Work on a branch `feat/<short-name>` (e.g. `feat/jira-sync`). Keep each commit to one coherent piece. Never commit to `main` directly.
5. Write the tests together with the code. A task is done only when `pnpm typecheck` and `pnpm test` pass.
6. Before you finish:
    - tick the task in §4 and add any new design choice to §5 (choices made in code that the plan doesn't state);
    - add anything left unfinished to §6 "Known gaps";
    - if the work changes the design (not just implements it), stop and ask the user. Plan changes follow [AGENTS.md](../../AGENTS.md) "Rules for workflow-improvement work".
7. Commit, then summarise for the user: what was built, the test results, and what is next.

**Ask the user, don't guess,** when a task needs real Copilot, GitLab or Jira access, credentials, or an answer from plan §13 that is still open.

## 2. Setup and checks

```sh
corepack enable          # provides pnpm, pinned in package.json (needed once per machine)
pnpm install
pnpm typecheck           # nx run-many -t typecheck
pnpm test                # nx run-many -t test (Vitest)
```

- Node ≥ 22 (built with Node 24), pnpm 12, TypeScript 7, Vitest 5, Nx 24.
- The lease tests create real git repos in the OS temp folder, so `git` must be on the PATH. They take about 20 s.
- If you got the repo as a **ZIP download**, it has no git history: run `git init`, then `git remote add origin https://github.com/jonney17/artifact-driven-workflow.git`, and `git fetch` before branching. A `git clone` is simpler.
- On Windows, if Nx says `'pnpm' is not recognized`, `corepack enable` wasn't run in that shell's Node install.

## 3. Code map

The repo is the `sdlc-engine` monorepo from plan §9. Packages are ESM TypeScript, imported by name through pnpm `workspace:*` links. Their `main` points at `src/index.ts`; there is no build step yet.

| Package | Files | What it does |
| --- | --- | --- |
| `libs/contracts` | `artifact.ts` `contract.ts` `overlay.ts` `events.ts` | Zod schemas and types: the artifact envelope, a pack contract, `team.yaml`, `events.log` events, leases. `PROTECTED_CONTRACT_FIELDS` lists what an overlay may never change. |
| `libs/runtimes` | `runner.ts` `stub.runner.ts` | The `Runner` interface (one attempt = one session) and `StubRunner`, which runs scripted handlers per contract id in tests. The Copilot SDK runner comes in step 5. |
| `libs/orchestrator` | `store.ts` | `ArtifactStore`: Markdown files with YAML front matter, `<root>/stories/<KEY>/artifacts/<id>.md`. The version goes up only when the body changes. |
| | `stale.ts` | `findStale`: the staleness cascade over `derived_from`. |
| | `contracts.ts` `resolve.ts` | Load a pack (`pack.yaml` + `contracts/*.yaml`); `resolveWorkflow` applies `team.yaml` and throws `OverlayError` if it touches inputs, outputs or write scope. |
| | `trigger.ts` | `evaluate`: the make-like trigger. It returns a run, idle or blocked decision with a reason for every instance. |
| | `writescope.ts` `validate.ts` | Write-scope and sensitive-path check; "Sensitive changes" parsing; required-section check on outputs. |
| | `recovery.ts` | `EventLog` (append-only JSONL per story) and `replay` (instance states, unfinished and waiting attempts, takeovers). |
| | `git.ts` `lease.ts` | `GitWorkspace` (pull, commit and push with rebase retry; a rebase conflict means "lost the race"); `LeaseManager` for story and team leases. |
| | `engine.ts` | `Engine.tick(story)`: stale events → evaluate → dispatch → validate → scope check → write outputs → events; `Engine.answer()` resumes a waiting session. |
| Tests | `libs/orchestrator/test/*.test.ts` | `fixtures.ts` holds a small 4-contract test pack (planner → developer per repo → reviewer per repo → qe-run fan-in). |

**Conventions:**

- **Schemas live in `libs/contracts`.** Validate everything read from disk or the network with Zod at the boundary.
- **Ids and keys:**
    - artifact id: `<type>-<story>` or `<type>-<story>-<repo>` (`artifactId()`)
    - instance key: `<contract>:<story>[:<repo>]` (`instanceKey()`)
    - answer artifact id: `answer-<instance with : → _>-a<attempt>` (`answerId()`)
- **Every side effect is an event** in the story's `events.log`. Outbound writes, from step 3 on, must be idempotent and keyed by event id (plan §2).
- **Tests:** Vitest, files in `test/`. Use temp dirs (`tempDir()`), never the repo, for written files. Fake servers for Jira, Confluence and GitLab go in `tests/` or each lib's `test/fakes/`, with recorded fixtures (plan §9).
- **No credentials ever reach a `Runner` request or an agent session** (invariant). Integrations hold tokens; the orchestrator passes only artifacts.

## 4. Build status

Plan §10 steps. ✅ done · 🔜 next · ⬜ not started · 👤 needs the team or real systems.

| Step | Status | Notes |
| --- | --- | --- |
| 1. Spikes (Copilot SDK, GitLab, Atlassian) | 👤 | Needs real accounts. Run by the team; results go into plan §13 and §5 below. Code can proceed against fakes. |
| 2. Engine core | ✅ (see §6 for gaps) | Branch `feat/engine-core`, 34 tests. |
| 3. Jira/Confluence/GitLab integration | 🔜 | Tasks below. |
| 4. Pack `safe-scrum` | ⬜ | `packs/safe-scrum/`: contracts, schemas, templates, 5 base prompts (plan §4, §4a). |
| 5. Copilot runner + hostgen + `ask_human` + question routing | ⬜ | `libs/runtimes/copilot-sdk.runner.ts`, `libs/hostgen`. Depends on the Copilot SDK spike. |
| 6. Service + CLI + `/sdlc` skill, then Web UI | ⬜ | `apps/server` (NestJS), `apps/cli`, `apps/web` (Angular). |
| 7. Telemetry + session retro | ⬜ | `libs/telemetry`, `libs/retro` (plan §7). |
| 8. First overlay + a throwaway second overlay | ⬜ | Needs the team's real `team.yaml` values. |

### Step 3 tasks (in order)

New lib `libs/integrations` (plan §9: `jira.ts`, `confluence.ts`, `gitlab.ts`, `mapping.ts`). Write each against a **fake server first**. Real endpoints are only reached in the spikes.

- [ ] **3.1 Finish the step 2 gaps that step 3 needs** (§6, items 1–3): the real `WorktreeProvider`, the workspace loop around `Engine.tick`, and per-machine concurrency.
- [ ] **3.2 Jira inbound** (plan §3 "Inbound", §3b):
    - intake by `intake_jql` + `AND assignee = currentUser()` → `story-<KEY>` artifacts (AC from the "Acceptance Criteria" field, auto-numbered `<KEY>-AC<n>`; Topic from Epic Link; `blocks` links → `depends_on`)
    - change detection: a new Jira version means a new artifact version
    - lifecycle events: carry-over, backlog pause, split (link "split from" or a "split from <KEY>" comment), cancel, reopen → defect
    - library: `jira.js`
- [ ] **3.3 Confluence inbound:** the Epic's "mentioned in" issue link → `topic-prd-<TOPIC>` snapshot with the page version, split by headings. No fixed page format (Q7). The store needs topic-scoped artifacts for this (§6, item 4).
- [ ] **3.4 Jira outbound** (plan §3 "Outbound"):
    - transitions per `status_map` (configurable, placeholders for now: Q6)
    - comments with a hidden idempotency marker
    - MR links (`jira_dev_panel: false`)
    - defects per `defects.mode`
    - gates from Jira: the "Accepted" transition, and the `/sdlc approve scenarios` comment command checked against `members` roles
- [ ] **3.5 GitLab** (plan §3a):
    - push `<KEY>/<repo>`; one Draft MR per Story × repo, idempotent across retries and restarts
    - pipeline polling; red → `pipeline` rework input
    - review findings → MR discussion threads with markers, never approvals
    - remove Draft after QE (c); labels incl. `sdlc-sensitive`
    - merge detection; upstream-first merge order from `depends_on`
    - GraphQL first, `@gitbeaker/rest` only where GraphQL lacks an operation
    - never use the GitLab MCP server
- [ ] **3.6 Tests from plan §11** "Jira sync" and "GitLab MRs", all against the fakes.

## 5. Design choices made in code (not stated in the plan)

Change these only on purpose, and say so in the commit message.

1. **Hashes cover the body only.** A status change such as approval never makes dependents stale.
2. **Status values the engine relies on:** `draft`, `ready`, `approved`, `rejected`, `cancelled`, `open` and `consumed` (rework inputs). A contract input accepts `ready` or `approved` by default; gated inputs list `approved`.
3. **Round limits:** the trigger blocks an instance when an *open* rework input of a type would exceed its `limits.*` value (e.g. a 3rd review with `review_rounds: 2`).
4. **Fan-in (`scope: any`)** needs a usable artifact from **every** affected repo, not just at least one.
5. **Write-scope placeholders** use `${name}` (e.g. `${test_dirs}/**`), because `{…}` is glob brace syntax.
6. **"Sensitive changes" format:** each bullet's first `code span` is a path or glob; "none" unlocks nothing.
7. **Failures:** a validation failure, scope violation or failed attempt counts as one failure. Two in a row (`maxFailures`) emits `instance.blocked`; `instance.unblocked` clears it.
8. **Crash recovery:** an attempt that was dispatched but never finished is re-dispatched with the **same attempt number in a new session**. Only an `ask_human` answer resumes the old session.
9. **Leases:** `GitWorkspace.commitAndPush` retries a rejected push after `pull --rebase`. A rebase conflict means another engine wrote the same lease file, so the claim is lost.

## 6. Known gaps (step 2)

1. **Worktrees:** the default `WorktreeProvider` returns a path only. Build the real one: `git worktree add` per attempt from the story branch, restored from the pushed WIP branch on recovery.
2. **The loop around `tick` isn't wired:** pull the workspace repo, claim, renew and release leases, then tick each owned story, then commit and push `.sdlc/work/`. Also the handover on reassignment (plan §2).
3. **Concurrency** is limited per `tick` call, not per machine across stories (`limits.concurrency` is per machine).
4. **Topic-scoped artifacts** (`.sdlc/work/topics/<TOPIC>/`) aren't in the store yet.
5. **Budget** (plan §5a): AI credits are recorded per attempt (`attempt.finished.data.ai_credits`). Nothing yet enforces the story budget, the personal reserve or `blocked: budget`.
6. **Takeover** (plan §6a): `takeover.started` and `takeover.ended` events stop and restart dispatch. Not built yet: the CLI command, the required reason, accepting human commits, and the rebase on handback.
7. **A story edit while a change folder is in progress** should set it `blocked` ("story changed") rather than re-run silently (plan §3). Today the trigger simply re-runs on stale output.
