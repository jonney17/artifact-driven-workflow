import 'reflect-metadata';
import { existsSync } from 'node:fs';
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

/** `sdlc serve`: the local API + Web UI, on 127.0.0.1 only (local mode: only the story owner reaches it). */
export async function startServer(ctx: SdlcContext, port: number, out: (l: string) => void = console.log): Promise<INestApplication> {
  const app = await createServer(ctx);
  await app.listen(port, '127.0.0.1');
  out(`sdlc UI and API on http://127.0.0.1:${port} as ${ctx.local.user}`);
  return app;
}

export { ApiController, SDLC_CONTEXT };
