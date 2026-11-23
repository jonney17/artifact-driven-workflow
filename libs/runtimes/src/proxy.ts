import { createServer, request as httpRequest, type Server } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { hostAllowed } from './policy';

export interface ProxyLogEntry {
  host: string;
  port: number;
  allowed: boolean;
  method: string;
}

/**
 * A per-session allowlisting HTTP(S) proxy (plan §5b "Network"): HTTPS goes through CONNECT, plain HTTP
 * is forwarded; anything to a host outside the allowlist gets 403. Best-effort: code that ignores
 * proxy settings can bypass it until sessions run in containers.
 */
export class AllowlistProxy {
  readonly log: ProxyLogEntry[] = [];
  private server?: Server;

  constructor(private readonly allow: string[]) {}

  async start(port = 0): Promise<string> {
    const server = createServer((req, res) => {
      let target: URL;
      try {
        target = new URL(req.url ?? '');
      } catch {
        res.writeHead(400).end();
        return;
      }
      const allowed = hostAllowed(target.hostname, this.allow);
      this.log.push({ host: target.hostname, port: Number(target.port || 80), allowed, method: req.method ?? 'GET' });
      if (!allowed) {
        res.writeHead(403, { 'Content-Type': 'text/plain' }).end(`blocked by the sdlc network allowlist: ${target.hostname}\n`);
        return;
      }
      const up = httpRequest(target, { method: req.method, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      up.on('error', () => res.writeHead(502).end());
      req.pipe(up);
    });
    server.on('connect', (req, client: Socket, head) => {
      const [host = '', portStr = '443'] = (req.url ?? '').split(':');
      const allowed = hostAllowed(host, this.allow);
      this.log.push({ host, port: Number(portStr), allowed, method: 'CONNECT' });
      if (!allowed) {
        client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      const upstream = connect(Number(portStr), host, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on('error', () => client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
      client.on('error', () => upstream.destroy());
    });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    this.server = server;
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}
