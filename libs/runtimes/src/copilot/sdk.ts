import type { PermissionRequest } from '../policy';

/**
 * The slice of the Copilot SDK the runner uses, as described in plan §5. The runner depends only on
 * this interface; `loadCopilotSdk()` adapts the real `@github/copilot-sdk` to it.
 * VERIFY IN THE COPILOT SDK SPIKE: names and shapes of the real API (see HANDOFF "Later on the work machine").
 */
export interface CopilotTool {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  parameters: Record<string, unknown>;
  handler(args: Record<string, unknown>): Promise<string>;
}

export interface CopilotSessionOptions {
  /** Custom agent name, from `.github/agents/<name>.agent.md` in `cwd`. */
  agent: string;
  cwd: string;
  model?: string;
  env: Record<string, string>;
  tools: CopilotTool[];
  onPermissionRequest(req: PermissionRequest): Promise<boolean>;
  /** Copilot's own `ask_user`; routed like `ask_human`. */
  onUserInputRequest(req: { question: string; choices?: string[] }): Promise<string>;
}

export interface CopilotTurnResult {
  stopReason: 'end_turn' | 'max_turns' | 'error' | 'aborted';
  error?: string;
  usage?: { aiCredits?: number; modelCalls?: { model: string; count: number }[] };
}

export interface CopilotSession {
  readonly id: string;
  /** Sends a prompt; resolves when the agent's turn ends. */
  send(prompt: string, opts?: { maxTurns?: number }): Promise<CopilotTurnResult>;
  abort(): Promise<void>;
  close(): Promise<void>;
}

export interface CopilotSdk {
  createSession(o: CopilotSessionOptions): Promise<CopilotSession>;
  resumeSession(id: string, o: CopilotSessionOptions): Promise<CopilotSession>;
}

/**
 * Loads the real SDK and adapts it. Kept tiny and isolated so the spike only has to fix this file.
 * Throws a clear error when the package isn't installed (e.g. on a machine without Copilot).
 */
export async function loadCopilotSdk(): Promise<CopilotSdk> {
  const name = '@github/copilot-sdk';
  let mod: any;
  try {
    mod = await import(/* @vite-ignore */ name);
  } catch {
    throw new Error(`${name} is not installed. Install it on a machine with a Copilot seat (pnpm add ${name} -F @sdlc/runtimes).`);
  }
  const client = new (mod.CopilotClient ?? mod.default)();
  const adapt = (s: any): CopilotSession => ({
    id: s.sessionId ?? s.id,
    send: async (prompt) => {
      const r = await (s.sendAndWait ?? s.send).call(s, { prompt });
      return { stopReason: r?.stopReason ?? 'end_turn', usage: r?.usage };
    },
    abort: async () => void (await s.abort?.()),
    close: async () => void (await (s.destroy ?? s.close)?.call(s)),
  });
  const toSdkOptions = (o: CopilotSessionOptions) => ({
    agent: o.agent,
    workingDirectory: o.cwd,
    model: o.model,
    env: o.env,
    tools: o.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters, handler: t.handler })),
    onPermissionRequest: o.onPermissionRequest,
    onUserInputRequest: o.onUserInputRequest,
  });
  return {
    createSession: async (o) => adapt(await client.createSession(toSdkOptions(o))),
    resumeSession: async (id, o) => adapt(await client.resumeSession(id, toSdkOptions(o))),
  };
}
