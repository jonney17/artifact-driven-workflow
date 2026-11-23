import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post, Query, Sse, type MessageEvent } from '@nestjs/common';
import { interval, map, distinctUntilChanged, switchMap, from, type Observable } from 'rxjs';
import { actions, activity, artifact, board, ForbiddenError, inbox, NotFoundError, questionsFor, type SdlcContext, storyView } from '@sdlc/app';
import { TAKEOVER_REASONS, type HandbackAt, type TakeoverReason, type TakeoverStep } from '@sdlc/orchestrator';

export const SDLC_CONTEXT = Symbol('SDLC_CONTEXT');

const STEPS = ['develop', 'planner', 'qe-write', 'qe-run'] as const;
const AT = ['develop', 'review', 'qe', 'gate', 'qe-write', 'done', 'judge'] as const;

/** Maps app errors to HTTP errors. */
async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ForbiddenError) throw new ForbiddenException(e.message);
    if (e instanceof NotFoundError) throw new NotFoundException(e.message);
    throw new BadRequestException((e as Error).message);
  }
}

const text = (v: unknown, name: string) => {
  if (typeof v !== 'string' || !v.trim()) throw new BadRequestException(`${name} is required`);
  return v;
};

/**
 * The local API behind the Web UI (plan §8). In local mode the server binds to 127.0.0.1 and acts as
 * the engine's owner (`local.user`); people other than the owner pass gates in Jira.
 */
@Controller('api')
export class ApiController {
  constructor(@Inject(SDLC_CONTEXT) private readonly ctx: SdlcContext) {}

  @Get('me')
  me() {
    return { user: this.ctx.local.user, roles: this.ctx.team.members[this.ctx.local.user] ?? [], team: this.ctx.workflow.overlay.team, pack: `${this.ctx.pack.name}@${this.ctx.pack.major}`, dryRun: this.ctx.dryRun };
  }

  @Get('board')
  board() {
    return board(this.ctx);
  }

  @Get('inbox')
  inbox() {
    return inbox(this.ctx);
  }

  @Get('questions')
  questions() {
    return questionsFor(this.ctx);
  }

  @Get('stories/:key')
  story(@Param('key') key: string) {
    return storyView(this.ctx, key);
  }

  @Get('stories/:key/events')
  events(@Param('key') key: string, @Query('limit') limit?: string) {
    return activity(this.ctx, key, limit ? Number(limit) : 100);
  }

  @Get('stories/:key/artifacts/:id')
  async artifact(@Param('key') key: string, @Param('id') id: string) {
    const a = await artifact(this.ctx, key, id);
    if (!a) throw new NotFoundException(`${id} not found`);
    return a;
  }

  @Post('stories/:key/artifacts/:id/approve')
  approve(@Param('key') key: string, @Param('id') id: string) {
    return call(async () => ({ approved: id, version: await actions.approve(this.ctx, key, id, this.ctx.local.user) }));
  }

  @Post('stories/:key/artifacts/:id/reject')
  reject(@Param('key') key: string, @Param('id') id: string, @Body() body: { reason?: string }) {
    return call(async () => {
      await actions.reject(this.ctx, key, id, this.ctx.local.user, text(body?.reason, 'reason'));
      return { rejected: id };
    });
  }

  @Post('stories/:key/questions/:qid/answer')
  answer(@Param('key') key: string, @Param('qid') qid: string, @Body() body: { text?: string }) {
    return call(async () => ({ result: await actions.answer(this.ctx, key, qid, this.ctx.local.user, text(body?.text, 'text')) }));
  }

  @Post('stories/:key/takeover')
  takeover(@Param('key') key: string, @Body() b: { repo?: string; step?: string; reason?: string; note?: string }) {
    const step = (b?.step ?? 'develop') as TakeoverStep;
    if (!STEPS.includes(step)) throw new BadRequestException(`step must be one of ${STEPS.join(', ')}`);
    if (!TAKEOVER_REASONS.includes(b?.reason as TakeoverReason)) throw new BadRequestException(`reason must be one of ${TAKEOVER_REASONS.join(', ')}`);
    return call(async () => ({ stopped: await actions.takeover(this.ctx, { key, ...(b.repo ? { repo: b.repo } : {}), step, reason: b.reason as TakeoverReason, note: text(b.note, 'note'), user: this.ctx.local.user }) }));
  }

  @Post('stories/:key/handback')
  handback(@Param('key') key: string, @Body() b: { repo?: string; step?: string; at?: string; summary?: string }) {
    const step = (b?.step ?? 'develop') as TakeoverStep;
    if (!AT.includes(b?.at as HandbackAt)) throw new BadRequestException(`at must be one of ${AT.join(', ')}`);
    return call(async () => {
      await actions.handback(this.ctx, { key, ...(b.repo ? { repo: b.repo } : {}), step, at: b.at as HandbackAt, user: this.ctx.local.user, ...(b.summary ? { summary: b.summary } : {}) });
      return { handedBack: key, at: b.at };
    });
  }

  @Post('stories/:key/budget/raise')
  raise(@Param('key') key: string, @Body() b: { amount?: number }) {
    if (!(Number(b?.amount) > 0)) throw new BadRequestException('amount must be a positive number');
    return call(async () => {
      await actions.raiseBudget(this.ctx, key, Number(b.amount), this.ctx.local.user);
      return { raised: key, by: Number(b.amount) };
    });
  }

  @Get('budget')
  async budget() {
    const allowance = this.ctx.local.monthly_allowance ?? this.ctx.team.budget.personal_reserve.monthly_allowance_default;
    return { month: await this.ctx.budget.monthUsed(), allowance, reserveStop: allowance * this.ctx.team.budget.personal_reserve.stop_at_share };
  }

  /** Server-sent events: the Board and the inbox, whenever they change (plan §9 "SSE"). */
  @Sse('stream')
  stream(): Observable<MessageEvent> {
    return interval(2000).pipe(
      switchMap(() => from(Promise.all([board(this.ctx), inbox(this.ctx)]))),
      map(([b, i]) => JSON.stringify({ board: b, inbox: i })),
      distinctUntilChanged(),
      map((data) => ({ data })),
    );
  }
}
