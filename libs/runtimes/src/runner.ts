import type { Artifact, ArtifactEnvelope } from '@sdlc/contracts';

/** What the orchestrator hands one attempt. Inputs are artifacts only, never another agent's transcript. */
export interface AttemptRequest {
  instance: string;
  contractId: string;
  agent: string;
  story: string;
  repo?: string;
  attempt: number;
  /** A fresh git worktree per attempt (plan §2). */
  workdir: string;
  inputs: Artifact[];
  reworkInputs: Artifact[];
  policy: {
    tools: string[];
    model?: string;
    maxTurns: number;
    writeAllow: string[];
    writeDeny: string[];
  };
  /** Set only when resuming an `ask_human` wait; every other attempt starts a new session. */
  resumeSessionId?: string;
}

/** An output the agent produced, before the engine assigns version, status and derived_from. */
export interface OutputDraft {
  type: string;
  repo?: string;
  body: string;
}

export type AttemptResult =
  | {
      status: 'done';
      sessionId: string;
      outputs: OutputDraft[];
      /** Paths changed in the worktree, relative to the repo root. */
      changedFiles: string[];
      aiCredits?: number;
    }
  | {
      status: 'waiting';
      sessionId: string;
      question: { route: string; text: string };
    }
  | { status: 'failed'; sessionId: string; reason: string };

/** A runtime that executes one attempt in its own session (Copilot SDK in production, a stub in tests). */
export interface Runner {
  readonly name: string;
  run(request: AttemptRequest): Promise<AttemptResult>;
}

export type { Artifact, ArtifactEnvelope };
