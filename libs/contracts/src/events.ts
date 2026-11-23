import { z } from 'zod';

/**
 * One line of a story's `events.log` (JSON Lines). The log is append-only and is the source for
 * restart recovery and idempotent outbound writes (plan §2).
 */
export const EngineEventSchema = z.object({
  /** Stable id; outbound writes (Jira comments, MR threads) carry it as an idempotency marker. */
  id: z.string().min(1),
  ts: z.string().datetime(),
  story: z.string().min(1),
  type: z.enum([
    'lease.claimed',
    'lease.released',
    'attempt.dispatched',
    'attempt.waiting',
    'attempt.resumed',
    'attempt.finished',
    'attempt.failed',
    'artifact.written',
    'artifact.stale',
    'scope.violation',
    'validation.failed',
    'instance.blocked',
    'instance.unblocked',
    'gate.passed',
    'gate.rejected',
    'takeover.started',
    'takeover.ended',
  ]),
  /** Instance key `<contract>:<story>[:<repo>]`, when the event concerns one instance. */
  instance: z.string().optional(),
  attempt: z.number().int().positive().optional(),
  session_id: z.string().optional(),
  data: z.record(z.string(), z.unknown()).default({}),
});
export type EngineEvent = z.infer<typeof EngineEventSchema>;
export type EngineEventType = EngineEvent['type'];

/** Story lease, `.sdlc/work/stories/<KEY>/owner.json` (plan §2). */
export const LeaseSchema = z.object({
  user: z.string().min(1),
  host: z.string().min(1),
  engine_id: z.string().min(1),
  heartbeat_at: z.string().datetime(),
});
export type Lease = z.infer<typeof LeaseSchema>;
