import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { setupDemo } from '@sdlc/app';
import { createServer, startServer } from '../src/index';

describe('local API (plan §8)', { timeout: 120_000 }, () => {
  it('serves the Board and inbox, passes a gate with the CSRF header, and checks roles', async () => {
    const demo = await setupDemo();
    await demo.cycle();
    await demo.cycle();
    const app = await createServer(demo.ctx, { logger: false, webDir: '/nonexistent' });
    await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api`;
    const get = async (p: string): Promise<any> => (await fetch(base + p)).json();
    const post = (p: string, body: unknown = {}, headers: Record<string, string> = { 'X-SDLC': '1' }) =>
      fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    try {
      expect(await get('/me')).toMatchObject({ user: 'bob@demo', roles: ['dev'], team: 'demo-squad', pack: 'safe-scrum@1' });
      const board = await get('/board');
      expect(board.map((s: { key: string; status: string }) => [s.key, s.status])).toEqual([['PAY-12', 'refining']]);
      expect((await get('/inbox')).map((i: { id: string }) => i.id)).toEqual(['proposal-PAY-12-billing-api', 'test-scenarios-PAY-12-billing-api']);
      expect((await get('/stories/PAY-12/artifacts/proposal-PAY-12-billing-api')).envelope.status).toBe('ready');

      // CSRF: no header → refused
      expect((await post('/stories/PAY-12/artifacts/proposal-PAY-12-billing-api/approve', {}, {})).status).toBe(403);
      // role check: bob (dev) can't approve QE scenarios
      const r1 = await post('/stories/PAY-12/artifacts/test-scenarios-PAY-12-billing-api/approve');
      expect(r1.status).toBe(403);
      expect(((await r1.json()) as any).message).toMatch(/needs role qe/);
      const r2 = await post('/stories/PAY-12/artifacts/proposal-PAY-12-billing-api/approve');
      expect(r2.status).toBe(201);
      expect(await r2.json()).toEqual({ approved: 'proposal-PAY-12-billing-api', version: 1 });
      expect((await get('/stories/PAY-12/artifacts/proposal-PAY-12-billing-api')).envelope.status).toBe('approved');

      expect((await post('/stories/PAY-12/takeover', { repo: 'billing-api', reason: 'nope', note: 'x' })).status).toBe(400);
      expect(await (await post('/stories/PAY-12/takeover', { repo: 'billing-api', reason: 'stuck', note: 'loops on tax' })).json()).toEqual({
        stopped: ['developer:PAY-12:billing-api', 'reviewer:PAY-12:billing-api'],
      });
      expect((await get('/stories/PAY-12')).instances.find((i: { instance: string }) => i.instance === 'developer:PAY-12:billing-api').state).toBe('human');
      expect((await post('/stories/PAY-12/budget/raise', { amount: -1 })).status).toBe(400);
      expect((await get('/stories/PAY-12/events?limit=1'))[0].type).toBe('takeover.started');
      expect((await fetch(`${base}/stories/PAY-12/artifacts/nope`)).status).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe('startServer', { timeout: 120_000 }, () => {
  it('falls back to a free port when the chosen one is taken or reserved (Windows: EACCES)', async () => {
    const { createServer: netServer } = await import('node:net');
    const blocker = netServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const taken = (blocker.address() as AddressInfo).port;
    const demo = await setupDemo();
    const lines: string[] = [];
    const app = await startServer(demo.ctx, taken, (l) => lines.push(l));
    try {
      const bound = (app.getHttpServer().address() as AddressInfo).port;
      expect(bound).not.toBe(taken);
      expect(lines[0]).toMatch(new RegExp(`^port ${taken} is in use or reserved`));
      expect(lines[1]).toBe(`sdlc UI and API on http://127.0.0.1:${bound} as bob@demo`);
    } finally {
      await app.close();
      blocker.close();
    }
  });
});
