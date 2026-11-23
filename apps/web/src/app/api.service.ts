import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export interface Me {
  user: string;
  roles: string[];
  team: string;
  pack: string;
  dryRun: boolean;
}
export interface StoryView {
  key: string;
  status?: string;
  repos: string[];
  lifecycle?: string;
  instances: { instance: string; state: string; attempt: number }[];
  gates: { artifact: string; type: string; repo?: string; version: number; gate: string }[];
  questions: { id: string; route: string; text: string; status: string; people: string[] }[];
  credits: { used: number; limit: number };
  artifacts: { id: string; type: string; status: string; version: number; repo?: string }[];
}
export interface InboxItem {
  kind: 'gate' | 'question' | 'blocked' | 'budget';
  story: string;
  id: string;
  text: string;
}
export interface Artifact {
  envelope: { id: string; type: string; version: number; status: string; produced_by: string; story: string; repo?: string; derived_from: { id: string; version: number }[] };
  body: string;
}
export interface EngineEvent {
  id: string;
  ts: string;
  type: string;
  instance?: string;
  attempt?: number;
  data: Record<string, unknown>;
}

/** The local API (apps/server). Changes carry `X-SDLC: 1` (the server's CSRF guard). */
@Injectable({ providedIn: 'root' })
export class Api {
  private readonly http = inject(HttpClient);
  private readonly write = { headers: new HttpHeaders({ 'X-SDLC': '1' }) };

  readonly board = signal<StoryView[]>([]);
  readonly inbox = signal<InboxItem[]>([]);
  readonly live = signal(false);

  me() {
    return firstValueFrom(this.http.get<Me>('/api/me'));
  }
  story(key: string) {
    return firstValueFrom(this.http.get<StoryView>(`/api/stories/${key}`));
  }
  events(key: string) {
    return firstValueFrom(this.http.get<EngineEvent[]>(`/api/stories/${key}/events?limit=200`));
  }
  artifact(key: string, id: string) {
    return firstValueFrom(this.http.get<Artifact>(`/api/stories/${key}/artifacts/${id}`));
  }
  budget() {
    return firstValueFrom(this.http.get<{ month: number; allowance: number; reserveStop: number }>('/api/budget'));
  }
  approve(key: string, id: string) {
    return firstValueFrom(this.http.post(`/api/stories/${key}/artifacts/${id}/approve`, {}, this.write));
  }
  reject(key: string, id: string, reason: string) {
    return firstValueFrom(this.http.post(`/api/stories/${key}/artifacts/${id}/reject`, { reason }, this.write));
  }
  answer(key: string, qid: string, text: string) {
    return firstValueFrom(this.http.post<{ result: string }>(`/api/stories/${key}/questions/${qid}/answer`, { text }, this.write));
  }
  takeover(key: string, body: { repo?: string; step: string; reason: string; note: string }) {
    return firstValueFrom(this.http.post<{ stopped: string[] }>(`/api/stories/${key}/takeover`, body, this.write));
  }
  handback(key: string, body: { repo?: string; step: string; at: string; summary?: string }) {
    return firstValueFrom(this.http.post(`/api/stories/${key}/handback`, body, this.write));
  }
  raise(key: string, amount: number) {
    return firstValueFrom(this.http.post(`/api/stories/${key}/budget/raise`, { amount }, this.write));
  }

  /** Loads the Board and inbox, then follows the server's SSE stream. */
  async connect(): Promise<void> {
    const [b, i] = await Promise.all([firstValueFrom(this.http.get<StoryView[]>('/api/board')), firstValueFrom(this.http.get<InboxItem[]>('/api/inbox'))]);
    this.board.set(b);
    this.inbox.set(i);
    const es = new EventSource('/api/stream');
    es.onopen = () => this.live.set(true);
    es.onerror = () => this.live.set(false);
    es.onmessage = (m) => {
      const d = JSON.parse(m.data) as { board: StoryView[]; inbox: InboxItem[] };
      this.board.set(d.board);
      this.inbox.set(d.inbox);
    };
  }
}

export const errorText = (e: unknown) => (e as { error?: { message?: string } })?.error?.message ?? String((e as Error)?.message ?? e);
