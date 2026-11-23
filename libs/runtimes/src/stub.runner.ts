import type { AttemptRequest, AttemptResult, Runner } from './runner';

export type StubHandler = (
  request: AttemptRequest,
  ctx: { sessionId: string },
) => AttemptResult | Promise<AttemptResult>;

/**
 * Deterministic runner for tests: each contract id maps to a scripted handler.
 * Every call is recorded. A call gets a new session id unless it resumes an `ask_human` wait.
 */
export class StubRunner implements Runner {
  readonly name = 'stub';
  readonly calls: AttemptRequest[] = [];
  private sessionSeq = 0;

  constructor(private readonly handlers: Record<string, StubHandler> = {}) {}

  on(contractId: string, handler: StubHandler): this {
    this.handlers[contractId] = handler;
    return this;
  }

  async run(request: AttemptRequest): Promise<AttemptResult> {
    this.calls.push(request);
    const sessionId = request.resumeSessionId ?? `stub-session-${++this.sessionSeq}`;
    const handler = this.handlers[request.contractId];
    if (!handler) return { status: 'failed', sessionId, reason: `no stub handler for ${request.contractId}` };
    return handler(request, { sessionId });
  }
}
