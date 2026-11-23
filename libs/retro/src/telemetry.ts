import { appendFile, mkdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

/**
 * Per-session OpenTelemetry settings for Copilot (plan §7): the runner adds these to the session env,
 * so Copilot's OTLP data joins the engine's events on `sdlc.instance` + `sdlc.attempt`.
 * VERIFY in the Copilot SDK spike which OTLP signals Copilot CLI emits and whether it honours these.
 */
export function otelEnv(endpoint: string, attrs: { team: string; story: string; repo?: string; agent: string; instance: string; attempt: number; overlayRev?: string | null }): Record<string, string> {
  const resource = {
    'sdlc.team': attrs.team,
    'sdlc.story': attrs.story,
    'sdlc.repo': attrs.repo ?? '',
    'sdlc.agent': attrs.agent,
    'sdlc.instance': attrs.instance,
    'sdlc.attempt': String(attrs.attempt),
    'sdlc.overlay_rev': attrs.overlayRev ?? '',
  };
  return {
    OTEL_SERVICE_NAME: `sdlc-${attrs.agent}`,
    OTEL_RESOURCE_ATTRIBUTES: Object.entries(resource).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join(','),
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
  };
}

/** Attribute keys that may carry prompt or completion text; dropped when `capture_content: false`. */
const CONTENT_KEYS = /(^|[._])(prompt|completion|content|messages?|body|text|(input|output)[._]value)([._]|$)/i;

/** Recursively removes content-bearing attributes from OTLP JSON. */
export function stripContent(v: unknown): unknown {
  if (Array.isArray(v)) {
    return v
      .filter((x) => !(x && typeof x === 'object' && 'key' in x && typeof (x as { key: unknown }).key === 'string' && CONTENT_KEYS.test((x as { key: string }).key) && !String((x as { key: string }).key).startsWith('sdlc.')))
      .map(stripContent);
  }
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !(k === 'body' || (CONTENT_KEYS.test(k) && k !== 'attributes'))).map(([k, x]) => [k, stripContent(x)]));
  return v;
}

/**
 * A tiny local OTLP/HTTP JSON receiver (`/v1/traces`, `/v1/metrics`, `/v1/logs`) that appends to
 * `<dir>/<signal>-<date>.jsonl`, with content stripped. Stands in for the plan's collector until the
 * DuckDB/Parquet store is set up on the work machine; `libs/telemetry` queries read these files.
 */
export class OtlpReceiver {
  private server?: Server;
  received = 0;

  constructor(
    private readonly dir: string,
    private readonly captureContent = false,
  ) {}

  async start(port = 0): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    this.server = createServer((req, res) => {
      const signal = /^\/v1\/(traces|metrics|logs)$/.exec(req.url ?? '')?.[1];
      if (req.method !== 'POST' || !signal) {
        res.writeHead(404).end();
        return;
      }
      if (!String(req.headers['content-type'] ?? '').includes('json')) {
        res.writeHead(415).end('only OTLP/HTTP JSON is accepted');
        return;
      }
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', async () => {
        try {
          const body = JSON.parse(raw);
          const kept = this.captureContent ? body : stripContent(body);
          await appendFile(join(this.dir, `${signal}-${new Date().toISOString().slice(0, 10)}.jsonl`), JSON.stringify(kept) + '\n', 'utf8');
          this.received++;
          res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
        } catch {
          res.writeHead(400).end();
        }
      });
    });
    await new Promise<void>((r) => this.server!.listen(port, '127.0.0.1', r));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop() {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}
