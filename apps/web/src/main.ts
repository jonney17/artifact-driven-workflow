import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter, withComponentInputBinding, type Routes } from '@angular/router';
import { App } from './app/app';
import { ArtifactPage, BoardPage, BudgetPage, InboxPage, StoryPage } from './app/pages';

const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'inbox' },
  { path: 'inbox', component: InboxPage },
  { path: 'board', component: BoardPage },
  { path: 'budget', component: BudgetPage },
  { path: 'stories/:key', component: StoryPage },
  { path: 'stories/:key/artifacts/:id', component: ArtifactPage },
];

bootstrapApplication(App, {
  providers: [provideZonelessChangeDetection(), provideHttpClient(), provideRouter(routes, withComponentInputBinding())],
}).catch((e) => console.error(e));
