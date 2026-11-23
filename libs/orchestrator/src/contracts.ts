import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { type Contract, ContractSchema } from '@sdlc/contracts';

export interface Pack {
  name: string;
  major: number;
  contracts: Contract[];
}

/** Parses contracts and checks that ids are unique. */
export function parseContracts(raw: unknown[]): Contract[] {
  const contracts = raw.map((r) => ContractSchema.parse(r));
  const seen = new Set<string>();
  for (const c of contracts) {
    if (seen.has(c.id)) throw new Error(`duplicate contract id: ${c.id}`);
    seen.add(c.id);
  }
  return contracts;
}

/** Loads a pack directory: `pack.yaml` ({name, version}) and `contracts/*.yaml`. */
export async function loadPack(dir: string): Promise<Pack> {
  const meta = parse(await readFile(join(dir, 'pack.yaml'), 'utf8')) as { name: string; version: number };
  const files = (await readdir(join(dir, 'contracts'))).filter((f) => /\.ya?ml$/.test(f)).sort();
  const raw = await Promise.all(files.map(async (f) => parse(await readFile(join(dir, 'contracts', f), 'utf8'))));
  return { name: meta.name, major: meta.version, contracts: parseContracts(raw) };
}
