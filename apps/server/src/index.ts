import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { type AddressInfo, createServer as createNetServer } from 'node:net';
import { join, resolve } from 'node:path';
import { type INestApplication, Module, type DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { static as expressStatic, type NextFunction, type Request, type Response } from 'express';
import type { SdlcContext } from '@sdlc/app';
import { ApiController, SDLC_CONTEXT } from './api.controller';

@Module({})
class SdlcModule {
  static with(ctx: SdlcContext): DynamicModule {
    return { module: SdlcModule, controllers: [ApiController], providers: [{ provide: SDLC_CONTEXT, useValue: ctx }] };
  }
}

/**
 * Requests that change something must carry `X-SDLC: 1`. Browsers can't add a custom header across
 * origins without a CORS preflight, which this server never allows, so other web pages can't
 * drive the local API (CSRF).
 */
export function csrfGuard(req: Request, res: Response, next: NextFunction) {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.header('x-sdlc') !== '1') {
    res.status(403).json({ message: 'missing X-SDLC header' });
    return;
  }
  next();
}

export async function createServer(ctx: SdlcContext, opts: { webDir?: string; logger?: boolean } = {}): Promise<INestApplication> {
  const app = await NestFactory.create(SdlcModule.with(ctx), { logger: opts.logger === false ? false : ['error', 'warn'] });
  app.use(csrfGuard);
  const web = opts.webDir ?? resolve(import.meta.dirname, '../../web/dist/browser');
  if (existsSync(web)) {
    const express = app.getHttpAdapter().getInstance();
    express.use(expressStatic(web));
    express.get(/^\/(?!api\/).*/, (_req: Request, res: Response) => res.sendFile(join(web, 'index.html')));
  }
  return app;
}

/** Default port of `sdlc serve`. Not 4317: that is the OTLP port, often taken or reserved by the OS. */
export const DEFAULT_PORT = 7317;

/** True when 127.0.0.1:<port> can be bound. Windows answers EACCES for ports in an excluded range. */
function portFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const probe = createNetServer();
    probe.once('error', () => done(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => done(true)));
  });
}

/**
 * `sdlc serve`: the local API + Web UI, on 127.0.0.1 only (local mode: only the story owner reaches it).
 * If the port is in use or reserved, it falls back to a free port and says so.
 */
export async function startServer(ctx: SdlcContext, port: number = DEFAULT_PORT, out: (l: string) => void = console.log): Promise<INestApplication> {
  let use = port;
  if (port !== 0 && !(await portFree(port))) {
    out(`port ${port} is in use or reserved by the OS; using a free port instead (pick one with --port)`);
    use = 0;
  }
  const app = await createServer(ctx);
  await app.listen(use, '127.0.0.1');
  const bound = (app.getHttpServer().address() as AddressInfo).port;
  out(`sdlc UI and API on http://127.0.0.1:${bound} as ${ctx.local.user}`);
  return app;
}

export { ApiController, SDLC_CONTEXT };
