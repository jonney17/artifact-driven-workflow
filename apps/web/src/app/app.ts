import { Component, inject, signal, type OnInit } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { Api, type Me } from './api.service';

@Component({
  selector: 'sdlc-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <header>
      <strong>sdlc</strong>
      <nav>
        <a routerLink="/inbox" routerLinkActive="active">Inbox @if (api.inbox().length) {<span class="count">{{ api.inbox().length }}</span>}</a>
        <a routerLink="/board" routerLinkActive="active">Board</a>
        <a routerLink="/budget" routerLinkActive="active">Budget</a>
      </nav>
      <span class="spacer"></span>
      @if (me(); as m) { <span class="muted">{{ m.user }} ({{ m.roles.join(', ') }}) · {{ m.team }} · {{ m.pack }}@if (m.dryRun) { · dry run }</span> }
      <span class="dot" [class.on]="api.live()" title="live updates"></span>
    </header>
    <main><router-outlet /></main>
  `,
})
export class App implements OnInit {
  readonly api = inject(Api);
  readonly me = signal<Me | undefined>(undefined);
  async ngOnInit() {
    this.me.set(await this.api.me());
    await this.api.connect();
  }
}
