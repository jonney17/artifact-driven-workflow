# Build handoff: continue building the workflow engine

Read this file first when asked to **"continue building the workflow"**. It says where the build stands, how the code is organised, what to do next, and what needs real systems. Keep it up to date: it is the only memory the next session (human or AI) has.

- **What we build:** the Phase 1 engine from [phase-1-plan.md](../plan/phase-1-plan.md) (approved 2026-11-23).
- **Build order:** plan §10. **Tests:** plan §11. **Rules that must hold:** [WORKFLOW.md](../workflow/WORKFLOW.md) §12 "Invariants".
- **Last updated:** 2026-11-23. Plan steps 2–8 are built and tested **against fakes and stubs** on a machine without Copilot, Jira or GitLab. Everything that needs the real systems is listed in §5 "Later on the work machine".

## 1. The protocol for "continue building the workflow"

1. Run the checks in §2 and make sure they pass before changing anything. If they fail, fix that first.
2. Pick work in this order:
    1. the items in §5 you can do on the current machine;
    2. the gaps in §6, top first.

   Don't skip ahead silently.
3. Read the plan sections the item names, and the plan §11 verification bullets for it. The tests you write come from those bullets.
4. Work on a branch `feat/<short-name>`. Keep each commit to one coherent piece. Never commit to `main` directly.
5. Write the tests together with the code. Done means `pnpm typecheck` and `pnpm test` pass.
6. Before you finish:
    - update §4 and §6, and add any new code-level design choice to §7;
    - if the work changes the design (not just implements it), stop and ask the user. Plan changes follow [AGENTS.md](../../AGENTS.md).
7. Commit, then summarise for the user: what was built, the test results, and what is next.

**Ask the user, don't guess,** when an item needs credentials, real Copilot, Jira or GitLab, or an answer from plan §13 that is still open.

## 2. Setup and checks

```sh
corepack enable          # provides pnpm, pinned in package.json (once per machine)
pnpm install
pnpm typecheck           # nx run-many -t typecheck (11 projects)
pnpm test                # nx run-many -t test (Vitest), about 3 minutes
pnpm --filter @sdlc/web build    # the Angular UI → apps/web/dist
pnpm --filter @sdlc/cli build    # the CLI bundle → apps/cli/dist/sdlc.mjs
node apps/cli/dist/sdlc.mjs demo --serve   # a whole story on fakes, then the UI on http://127.0.0.1:7317
```

- **Requirements:** Node ≥ 22 (built on 24.13), git on the PATH. pnpm 12, TypeScript 7 for the engine, TypeScript 6.0 for the UI only, Vitest 5, Nx 24, Angular 21.2.
- **Tests use real git:** several tests create real git repos in the OS temp folder.
- **On Windows:** if Nx says `'pnpm' is not recognized`, `corepack enable` wasn't run for that Node install.
- **Prefer `git clone`:** a ZIP download has no git history. If you have one: `git init`, `git remote add origin https://github.com/jonney17/artifact-driven-workflow.git`, then `git fetch`.

## 3. Code map

The repo is the `sdlc-engine` Nx monorepo from plan §9. Packages are ESM TypeScript, linked with pnpm `workspace:*`, with `main` pointing at `src/index.ts`. Only the CLI (esbuild) and the UI (Angular) have a build step.

| Package | What it does | Plan |
| --- | --- | --- |
| `libs/contracts` | Zod schemas: artifact envelope, pack contracts (outputs with `multiple`, `numbered`, `optional`, `gated` and `verdicts`), `team.yaml`, `events.log` events, leases | §1, §2 |
| `libs/runtimes` | `Runner` interface, `StubRunner`, **`CopilotRunner`** (against `copilot/sdk.ts`, an interface shaped like the SDK; `loadCopilotSdk()` is the unverified adapter), tool policy (`decidePermission`), stripped session env, allowlisting proxy, `QuestionRouter` (`ask_human`), Teams webhook, write-scope check | §5, §5b, §6 |
| `libs/orchestrator` | Artifact store, staleness, pack loading, overlay resolve, trigger, output planning (verdicts → rework), the engine tick, gates, budget, environments, takeover/handback, `events.log` + replay, git workspace + leases, worktrees, the engine loop, Jira status rules | §2, §5a, §6a |
| `libs/integrations` | Jira (REST client, fake, intake, lifecycle, outbound, gates), Confluence (client, fake, PRD snapshot), GitLab (GraphQL client, fake, MR sync), `JiraInbound`, `StorySync` (the loop hooks), `JiraQuestionNotifier` | §3, §3a, §3b |
| `libs/hostgen` | `sdlc build`: `.github/agents/sdlc-<agent>.agent.md` from pack + overlay; installs one agent's skills into a worktree | §5 |
| `libs/retro` | Session records and signals, story metrics, one-line Jira summary, Coach (a) and (b), recurrence, effect check, hit rate, OTLP env, local OTLP receiver | §7 |
| `libs/app` | Composition root `createContext` (team.yaml + `~/.sdlc/config.yaml`), environments (local stack, preprod lease), Board/Inbox views, shared human `actions` (role-checked), `RetroService`, the demo | §8 |
| `apps/cli` | `sdlc` (commander, bundled to `dist/sdlc.mjs`): init, doctor, build, run, status, inbox, show, log, approve, reject, questions, answer, budget, takeover, handback, metrics, improve, demo, serve | §8 |
| `apps/server` | NestJS local API (`/api/...`, SSE), 127.0.0.1 only, CSRF header guard, serves the UI | §8 |
| `apps/web` | Angular UI: Inbox, Board, Story (flow, gates, questions, artifacts, takeover, budget, activity), artifact viewer, Budget | §8 |
| `packs/safe-scrum` | `pack.yaml`, 7 contracts, 12 templates, base prompts for 5 agents; `test/flow.test.ts` runs one story from Jira to Done | §4, §4a |
| `examples/overlays` | `payments-squad/team.yaml` (the plan's, with the team's §13 answers) and `throwaway/` (a second team, proving reuse) | §10 step 8 |
| `skills/sdlc` | The `/sdlc` skill for Copilot Chat | §9 |

**Conventions:**

- **Schemas:** they live in `libs/contracts`. Validate with Zod at every boundary.
- **Ids:**
    - artifact `<type>-<story>[-<repo>][-<n>]`;
    - instance `<contract>:<story>[:<repo>]`;
    - answer `answer-<instance with : → _>-a<attempt>`.
- **Events:** every side effect is an event in `events.log`. Outbound writes are idempotent: hidden Jira comment properties, MR thread markers, upsert by global id.
- **Credentials:** no credential ever reaches a `Runner` request or a session env (invariant). Only `libs/app/context.ts` reads tokens, from env vars.
- **Tests:** temp dirs only; fakes for Jira, Confluence and GitLab; `setupDemo()` for whole-app tests.

## 4. Build status

✅ done (against fakes) · 👤 needs the work machine or real systems (see §5)

| Step | Status | Notes |
| --- | --- | --- |
| 1. Spikes (Copilot SDK, GitLab, Atlassian) | 👤 | §5 A |
| 2. Engine core | ✅ | worktrees, loop, leases, recovery, machine-wide concurrency |
| 3. Jira/Confluence/GitLab integration | ✅ | real clients written but unverified (§5 A) |
| 4. Pack `safe-scrum` | ✅ | flow test runs one story end to end |
| 5. Copilot runner + hostgen + `ask_human` + routing | ✅ (fake SDK) | real SDK binding: §5 A |
| 6. Service + CLI + `/sdlc` skill, Web UI | ✅ | UI not checked visually yet (§5 G) |
| 7. Telemetry + session retro | ✅ | JSONL store, not DuckDB yet (§6) |
| 8. First overlay + throwaway overlay | ✅ | real team values: §5 C |

## 5. Later on the work machine (needs Copilot, Jira, GitLab or the team)

Do these on a machine with the team's accounts. Each lists where the code is.

- **A. Spikes (plan §10 step 1):** verify the real APIs and fix only the thin adapters.
    - **Copilot SDK:** `pnpm add @github/copilot-sdk -F @sdlc/runtimes`, then fix `libs/runtimes/src/copilot/sdk.ts` `loadCopilotSdk()` to the real API. Check against the plan §10 list:
        - long tool waits (more than 20 minutes);
        - `resumeSession` after a restart;
        - OTLP export and its attributes;
        - AI credits per session (or `credit_rates`);
        - a model per agent;
        - authentication with the stripped env (`sessionEnv`);
        - proxy compliance;
        - the custom agent file format and tool names (`libs/hostgen` `copilotTools`).

      If a capability is missing, add an ACP or one-shot CLI runner behind the same `Runner` interface.
    - **GitLab:** check every query and mutation in `libs/integrations/src/gitlab/graphql.ts` against the org's GitLab:
        - `mergeRequestCreate` with labels, `mergeRequestSetDraft`, `createDiscussion`, pipelines and jobs;
        - the token type;
        - that approval rules exclude the bot.
    - **Atlassian:** check `libs/integrations/src/jira/rest.ts` and `confluence/api.ts` (v2 REST or v3/ADF bodies), and:
        - comment `properties` support (used for idempotency);
        - field names (`Acceptance Criteria`, `Epic Link`, `Sprint`);
        - the transitions for `status_map` (Q6);
        - the "split from" link type name (Q9);
        - the "mentioned in" PRD link (Q7).
- **B. Credentials:** set `JIRA_EMAIL` + `JIRA_API_TOKEN` (or `JIRA_PAT`) and `GITLAB_TOKEN` for the engine process only. **TODO:** read them from the OS keychain instead (`libs/app/src/context.ts`).
- **C. Workspace repo:**
    - create `<team>-sdlc-workspace` on GitLab (Q13);
    - copy `examples/overlays/payments-squad/` to `.sdlc/team/`;
    - fill in the real values:
        - models (Q1);
        - `status_map` (Q6);
        - the allowlist (Q12);
        - `members`;
        - `repos`;
        - `runtime.workspace_repo`;
    - run `sdlc build` and commit `.github/agents/`.
- **D. Local stack:** the SM writes `.sdlc/team/local-stack/compose.yaml` (Q19); check that `docker compose up -d --wait` works.
- **E. Sandbox run (plan §12):**
    - create a sandbox Jira project and sandbox GitLab repos (Q14);
    - run `sdlc init`, `sdlc doctor` and `sdlc run --dry-run`;
    - then a real sandbox run, then the real sprint.
- **F. Security sign-off (Q12):** process-level isolation, and the real allowlist hosts.
- **G. Look at the UI:** run `node apps/cli/dist/sdlc.mjs demo --serve` and click through Inbox, Board and Story. It works on any machine, including this one.
- **H. Plan §11 bullets that need real systems:** the Jira dev panel, real pipelines, real Copilot sessions, OTLP from Copilot, and the proxy against Maven, pnpm and Copilot.

## 6. Known gaps (found while building; in priority order)

1. **QE (b) and the Developer want the same branch at the same time.**
    - `qe-write` and `developer` both get a worktree on `<KEY>/<repo>`, and git won't check out one branch in two worktrees.
    - Plan §4a: QE (b) works "in a separate worktree on the same Story branch… the engine rebases before each push".
    - Fix: QE (b) works on `<KEY>/<repo>--qe`, and the engine merges or rebases it into the story branch before pushing (`GitWorktreeProvider`, `StorySync.syncOut`).
2. **A fix after merge needs a new branch and MR.** For a preprod-check defect or a reopened story, plan §3b says "a new branch from main with a new MR". Today the sync refuses a second MR from a merged branch, so that fix gets no MR. Use `<KEY>/<repo>/fix-<n>`.
3. **Repo-to-repo order isn't modelled.** Two things are missing:
    - the Developer's "upstream repos ≥ review" input;
    - wiring `upstreamPending` / `WAITING_UPSTREAM_LABEL` into `StorySync`, because nothing declares which repo depends on which. Add a "Depends on repos" line to the proposal template.
4. **A story edit while work is in progress** should set the change folder to `blocked` ("story changed", plan §3). Today it re-runs on the stale input.
5. **Change folder files** (`{repo}/.team/changes/{story}/proposal.md`, `tasks.md`, `status.json`) aren't written into the repo branch yet. The artifacts live only in the workspace repo.
6. **Handback details (plan §6a) not yet built:**
    - `develop` handback asking the agent to write only `mr-description`;
    - human commits without a takeover (rebase or pause on conflict);
    - flagging human edits inside `test_dirs`.
7. **Questions:** SLA reminders and blocked-list escalation (`questions.sla_hours`) aren't built.
8. **Self-improvement:**
    - the draft revert MR on a worse verdict, and syncing improvement status (merged, rejected) from GitLab;
    - the "overturned assumptions" metric is always 0;
    - joining Copilot's OTLP tool calls into the session records;
    - the DuckDB/Parquet store (today: JSONL in `~/.sdlc/telemetry/`).
9. **Web UI:** the flow graph, the Improvements view (Coach MRs, hit rate, effect checks) and Settings aren't built.
10. **Team host mode** (`runtime.mode: team_host`, webhooks, GitLab OAuth): later phase.

## 7. Design choices made in code (not stated in the plan)

Change these only on purpose, and say so in the commit message.

1. **Staleness:**
    - hashes cover the body only, so approval never makes dependents stale;
    - **rework inputs aren't pinned in `derived_from`**, because pinning them made a staleness cycle through the review.
2. **Statuses the engine relies on:** `draft`, `ready`, `approved`, `rejected`, `cancelled`, `open`, `consumed`. Verdicts add their own: `changes_requested`, `failed`, `passed`. Gated outputs wait at `ready`; `gated: false` opts an output out (e.g. `explore`).
3. **Rework and gates:**
    - round limits: an *open* rework input beyond `limits.<x>` blocks the instance;
    - fan-in (`scope: any`) needs a usable artifact from **every** affected repo;
    - gate rejections become `<type>-feedback` rework for the producer.
4. **Write scope:**
    - placeholders use `${name}`, because `{…}` is glob syntax;
    - "Sensitive changes" bullets: the first code span is a path; `none` unlocks nothing.
5. **Failures and recovery:**
    - two failures in a row block an instance;
    - a busy environment (`EnvironmentBusyError`, e.g. the preprod lease) queues without counting a failure;
    - a crashed attempt is re-dispatched with the same number in a new session.
6. **Leases:**
    - a rejected push is retried after `pull --rebase --autostash`; a rebase conflict means the lease was lost;
    - the loop also commits `topics/` (PRD snapshots keyed by page version).
7. **Jira:**
    - the engine never moves a story out of a human gate status ("Accepted") except to Done;
    - it transitions only when its own derived status changes.
8. **Libraries:**
    - Jira and Confluence use plain `fetch`, not `jira.js`;
    - GitLab uses `fetch` with GraphQL, not `@gitbeaker/rest`;
    - both keep the clients thin and easy to record in tests.
9. **UI:**
    - Angular 21.2, because 22.x needs Node ≥ 24.15;
    - the API requires an `X-SDLC: 1` header on writes (CSRF).
10. **Agent outputs:** agents write their outputs to `.sdlc-out/<type>[--<repo>][--<n>].md`. The runner adds `.sdlc-out/`, `.github/agents/sdlc-*` and `.github/skills/` to `.git/info/exclude`, so they never count as agent writes.
