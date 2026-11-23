import {
  type AgentOverlay,
  type Contract,
  type Limits,
  PROTECTED_CONTRACT_FIELDS,
  type TeamOverlay,
  TeamOverlaySchema,
} from '@sdlc/contracts';
import type { Pack } from './contracts';

export class OverlayError extends Error {}

/** A pack contract combined with the team overlay. The contract part is never changed by the overlay. */
export interface ResolvedContract {
  contract: Contract;
  overlay: AgentOverlay;
  enabled: boolean;
  gateMode: 'human' | 'auto' | null;
  maxTurns: number;
}

export interface ResolvedWorkflow {
  overlay: TeamOverlay;
  limits: Limits;
  contracts: ResolvedContract[];
}

/**
 * Validates `team.yaml` and applies it to the pack (plan §1). The overlay may change how an agent
 * works (model, instructions, skills, limits, gate mode, enabled) but never what it consumes or
 * produces. Any attempt to do so is an error, not a silent ignore.
 */
export function resolveWorkflow(pack: Pack, rawOverlay: unknown): ResolvedWorkflow {
  if (rawOverlay && typeof rawOverlay === 'object' && 'contracts' in rawOverlay) {
    throw new OverlayError('the overlay may not define or change contracts; contracts belong to the pack');
  }
  const agentsRaw = (rawOverlay as { agents?: Record<string, Record<string, unknown>> } | null)?.agents ?? {};
  for (const [agent, settings] of Object.entries(agentsRaw)) {
    for (const field of PROTECTED_CONTRACT_FIELDS) {
      if (settings && field in settings) {
        throw new OverlayError(`agents.${agent}.${field}: the overlay may not change what an agent consumes, produces or may write`);
      }
    }
  }

  const parsed = TeamOverlaySchema.safeParse(rawOverlay);
  if (!parsed.success) {
    throw new OverlayError(`invalid team.yaml: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const overlay = parsed.data;
  const expected = `${pack.name}@${pack.major}`;
  if (overlay.pack !== expected) throw new OverlayError(`team.yaml uses pack ${overlay.pack}, but the loaded pack is ${expected}`);

  const agents = new Set([...pack.contracts.map((c) => c.agent), ...Object.keys(pack.agents ?? {})]);
  for (const name of Object.keys(overlay.agents)) {
    if (!agents.has(name)) throw new OverlayError(`agents.${name}: no such agent in pack ${expected}`);
  }

  const contracts = pack.contracts.map((contract): ResolvedContract => {
    const ov = overlay.agents[contract.agent] ?? {};
    const gateMode = contract.gate ? (overlay.gates[contract.gate] ?? ov.gate_mode ?? 'human') : null;
    return {
      contract,
      overlay: ov,
      enabled: ov.enabled ?? true,
      gateMode,
      maxTurns: ov.max_turns_per_session ?? overlay.limits.max_turns_per_session,
    };
  });
  return { overlay, limits: overlay.limits, contracts };
}
