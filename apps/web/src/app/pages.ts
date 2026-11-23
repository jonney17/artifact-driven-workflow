import { Component, computed, inject, input, signal, type OnInit } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api, type Artifact, type EngineEvent, errorText, type StoryView } from './api.service';

/** The workflow's Jira statuses in order, for the progress bar. */
const STATUSES = ['refining', 'in_progress', 'in_review', 'in_qa', 'ready_for_acceptance', 'done'];
const label = (s?: string) => (s ?? 'not started').replace(/_/g, ' ');

@Component({
  selector: 'sdlc-inbox',
  imports: [RouterLink, FormsModule],
  template: `
    <h1>Inbox</h1>
    @if (error()) { <p class="error">{{ error() }}</p> }
    @if (api.inbox().length === 0) { <p class="muted">Nothing needs you right now.</p> }
    @for (item of api.inbox(); track item.kind + item.story + item.id) {
      <section class="card">
        <div class="row">
          <span class="badge" [class]="item.kind">{{ item.kind }}</span>
          <a [routerLink]="['/stories', item.story]">{{ item.story }}</a>
          <span>{{ item.text }}</span>
        </div>
        @switch (item.kind) {
          @case ('gate') {
            <div class="row">
              <a [routerLink]="['/stories', item.story, 'artifacts', item.id]">Read {{ item.id }}</a>
              <button (click)="approve(item.story, item.id)">Approve</button>
              <input [(ngModel)]="reasons[item.id]" placeholder="Why reject? (sent to the agent as rework)" />
              <button class="secondary" [disabled]="!reasons[item.id]" (click)="reject(item.story, item.id)">Reject</button>
            </div>
          }
          @case ('question') {
            <div class="row">
              <input class="wide" [(ngModel)]="answers[item.id]" placeholder="Your answer" />
              <button [disabled]="!answers[item.id]" (click)="answer(item.story, item.id)">Answer</button>
            </div>
          }
        }
      </section>
    }
  `,
})
export class InboxPage {
  readonly api = inject(Api);
  readonly error = signal('');
  reasons: Record<string, string> = {};
  answers: Record<string, string> = {};

  private async run(fn: () => Promise<unknown>) {
    this.error.set('');
    try {
      await fn();
      await this.api.connect();
    } catch (e) {
      this.error.set(errorText(e));
    }
  }
  approve(story: string, id: string) {
    return this.run(() => this.api.approve(story, id));
  }
  reject(story: string, id: string) {
    return this.run(() => this.api.reject(story, id, this.reasons[id] ?? ''));
  }
  answer(story: string, id: string) {
    return this.run(() => this.api.answer(story, id, this.answers[id] ?? ''));
  }
}

@Component({
  selector: 'sdlc-board',
  imports: [RouterLink, DecimalPipe],
  template: `
    <h1>Board</h1>
    @if (api.board().length === 0) { <p class="muted">No stories yet. The engine picks up stories assigned to you in the active sprint.</p> }
    <table>
      <thead><tr><th>Story</th><th>Status</th><th>Progress</th><th>Repos</th><th>Waiting for you</th><th>AI credits</th></tr></thead>
      <tbody>
        @for (s of api.board(); track s.key) {
          <tr>
            <td><a [routerLink]="['/stories', s.key]">{{ s.key }}</a></td>
            <td>{{ label(s.status) }}@if (s.lifecycle && s.lifecycle !== 'active') { <span class="badge">{{ s.lifecycle }}</span> }</td>
            <td><div class="progress"><div [style.width.%]="progress(s)"></div></div></td>
            <td>{{ s.repos.join(', ') || '–' }}</td>
            <td>{{ s.gates.length }} gates · {{ s.questions.length }} questions</td>
            <td [class.warn]="s.credits.used >= s.credits.limit * 0.8">{{ s.credits.used | number }} / {{ s.credits.limit | number }}</td>
          </tr>
        }
      </tbody>
    </table>
  `,
})
export class BoardPage {
  readonly api = inject(Api);
  readonly label = label;
  progress(s: StoryView) {
    return ((STATUSES.indexOf(s.status ?? '') + 1) / STATUSES.length) * 100;
  }
}

@Component({
  selector: 'sdlc-story',
  imports: [RouterLink, FormsModule, DatePipe, DecimalPipe],
  template: `
    @if (story(); as s) {
      <h1>{{ s.key }} <span class="muted">{{ label(s.status) }}</span></h1>
      <p class="muted">Repos: {{ s.repos.join(', ') || '–' }} · AI credits {{ s.credits.used | number }} / {{ s.credits.limit | number }}</p>
      @if (error()) { <p class="error">{{ error() }}</p> }

      <h2>Flow</h2>
      <div class="flow">
        @for (i of s.instances; track i.instance) {
          <div class="step" [class]="i.state"><strong>{{ i.instance.split(':')[0] }}</strong>@if (i.instance.split(':')[2]) {<span> · {{ i.instance.split(':')[2] }}</span>}<br /><small>{{ i.state }} · attempt {{ i.attempt }}</small></div>
        }
      </div>

      @if (s.gates.length) {
        <h2>Gates</h2>
        @for (g of s.gates; track g.artifact) {
          <div class="row card">
            <span class="badge gate">{{ g.gate }}</span>
            <a [routerLink]="['/stories', s.key, 'artifacts', g.artifact]">{{ g.artifact }} v{{ g.version }}</a>
            <button (click)="act(api.approve(s.key, g.artifact))">Approve</button>
            <input [(ngModel)]="reason" placeholder="Why reject?" />
            <button class="secondary" [disabled]="!reason" (click)="act(api.reject(s.key, g.artifact, reason))">Reject</button>
          </div>
        }
      }

      @if (s.questions.length) {
        <h2>Questions</h2>
        @for (q of s.questions; track q.id) {
          <div class="card">
            <p><strong>{{ q.id }}</strong> ({{ q.route }}, for {{ q.people.join(', ') }}): {{ q.text }}</p>
            <div class="row"><input class="wide" [(ngModel)]="answerText" placeholder="Answer" /><button [disabled]="!answerText" (click)="act(api.answer(s.key, q.id, answerText))">Answer</button></div>
          </div>
        }
      }

      <h2>Artifacts</h2>
      <table>
        <thead><tr><th>Artifact</th><th>Type</th><th>Repo</th><th>Version</th><th>Status</th></tr></thead>
        <tbody>
          @for (a of s.artifacts; track a.id) {
            <tr><td><a [routerLink]="['/stories', s.key, 'artifacts', a.id]">{{ a.id }}</a></td><td>{{ a.type }}</td><td>{{ a.repo ?? '–' }}</td><td>v{{ a.version }}</td><td><span class="badge" [class]="a.status">{{ a.status }}</span></td></tr>
          }
        </tbody>
      </table>

      <h2>Take over a step</h2>
      <div class="row card">
        <select [(ngModel)]="t.step"><option>develop</option><option>planner</option><option>qe-write</option><option>qe-run</option></select>
        <select [(ngModel)]="t.repo"><option value="">(story)</option>@for (r of s.repos; track r) {<option [value]="r">{{ r }}</option>}</select>
        <select [(ngModel)]="t.reason"><option>stuck</option><option>wrong-approach</option><option>delicate-change</option><option>faster-by-hand</option><option>other</option></select>
        <input [(ngModel)]="t.note" placeholder="Short note (required)" />
        <button [disabled]="!t.note" (click)="act(api.takeover(s.key, { step: t.step, reason: t.reason, note: t.note, repo: t.repo || undefined }))">Take over</button>
        <select [(ngModel)]="t.at"><option>develop</option><option>review</option><option>qe</option><option>gate</option><option>qe-write</option><option>done</option><option>judge</option></select>
        <button class="secondary" (click)="act(api.handback(s.key, { step: t.step, at: t.at, repo: t.repo || undefined }))">Hand back</button>
      </div>

      <h2>Budget</h2>
      <div class="row"><input type="number" [(ngModel)]="raiseBy" /><button (click)="act(api.raise(s.key, raiseBy))">Raise this story's AI credits</button></div>

      <h2>Activity</h2>
      <table class="events">
        @for (e of events(); track e.id) {
          <tr><td>{{ e.ts | date: 'MMM d, HH:mm:ss' }}</td><td>{{ e.type }}</td><td>{{ e.instance ?? '' }}@if (e.attempt) { #{{ e.attempt }} }</td><td class="muted">{{ detail(e) }}</td></tr>
        }
      </table>
    }
  `,
})
export class StoryPage implements OnInit {
  readonly api = inject(Api);
  readonly key = input.required<string>();
  readonly story = signal<StoryView | undefined>(undefined);
  readonly events = signal<EngineEvent[]>([]);
  readonly error = signal('');
  readonly label = label;
  reason = '';
  answerText = '';
  raiseBy = 1000;
  t = { step: 'develop', repo: '', reason: 'stuck', note: '', at: 'develop' };

  async ngOnInit() {
    await this.load();
  }
  async load() {
    this.story.set(await this.api.story(this.key()));
    this.events.set((await this.api.events(this.key())).reverse());
  }
  async act(p: Promise<unknown>) {
    this.error.set('');
    try {
      await p;
      this.reason = '';
      this.answerText = '';
      await this.load();
    } catch (e) {
      this.error.set(errorText(e));
    }
  }
  detail(e: EngineEvent) {
    const d = e.data;
    return String(d['reason'] ?? d['artifact'] ?? (d['question'] as { text?: string } | undefined)?.text ?? '');
  }
}

@Component({
  selector: 'sdlc-artifact',
  imports: [RouterLink],
  template: `
    @if (artifact(); as a) {
      <p><a [routerLink]="['/stories', key()]">← {{ key() }}</a></p>
      <h1>{{ a.envelope.id }}</h1>
      <p class="muted">{{ a.envelope.type }} v{{ a.envelope.version }} · {{ a.envelope.status }} · produced by {{ a.envelope.produced_by }}
        @if (a.envelope.derived_from.length) { · from {{ derived() }} }</p>
      <pre class="doc">{{ a.body }}</pre>
    }
  `,
})
export class ArtifactPage implements OnInit {
  private readonly api = inject(Api);
  readonly key = input.required<string>();
  readonly id = input.required<string>();
  readonly artifact = signal<Artifact | undefined>(undefined);
  readonly derived = computed(() => this.artifact()?.envelope.derived_from.map((d) => `${d.id} v${d.version}`).join(', ') ?? '');
  async ngOnInit() {
    this.artifact.set(await this.api.artifact(this.key(), this.id()));
  }
}

@Component({
  selector: 'sdlc-budget',
  imports: [DecimalPipe],
  template: `
    <h1>Budget</h1>
    @if (b(); as b) {
      <p>Your AI credits this month (only you see this): <strong>{{ b.month | number }}</strong> of {{ b.allowance | number }}.
        New agent sessions stop at {{ b.reserveStop | number }} to keep the rest for your own Copilot use.</p>
      <div class="progress"><div [style.width.%]="(b.month / b.reserveStop) * 100"></div></div>
    }
    <h2>Per story</h2>
    <table>
      @for (s of api.board(); track s.key) { <tr><td>{{ s.key }}</td><td>{{ s.credits.used | number }} / {{ s.credits.limit | number }}</td></tr> }
    </table>
  `,
})
export class BudgetPage implements OnInit {
  readonly api = inject(Api);
  readonly b = signal<{ month: number; allowance: number; reserveStop: number } | undefined>(undefined);
  async ngOnInit() {
    this.b.set(await this.api.budget());
  }
}
