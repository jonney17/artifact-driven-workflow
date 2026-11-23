import TurndownService from 'turndown';
import type { JiraRemoteLink } from '../jira/api';
import { fenceUntrusted } from '../untrusted';
import type { ConfluencePage } from './api';

/** The PRD page id from the Epic's Confluence issue links (Q7: relationship "mentioned in"). */
export function prdPageId(links: JiraRemoteLink[], relationship: string): string | undefined {
  const link = links.find((l) => (l.relationship ?? '').toLowerCase() === relationship.toLowerCase() && /pageId=\d+|\/pages\/\d+/.test(l.url));
  const m = link && (/pageId=(\d+)/.exec(link.url) ?? /\/pages\/(\d+)/.exec(link.url));
  return m?.[1];
}

const turndown = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' });

export function pageToMarkdown(html: string): string {
  return turndown.turndown(html).replace(/\n{3,}/g, '\n\n').trim();
}

export interface PrdSection {
  heading: string;
  level: number;
  text: string;
}

/**
 * Splits the PRD by its headings (plan §3). No page format is required (Q7): a page without headings is
 * one section. Requirement ids like `FR12` are found wherever they appear.
 */
export function splitSections(markdown: string): PrdSection[] {
  const sections: PrdSection[] = [];
  let cur: PrdSection = { heading: '(intro)', level: 0, text: '' };
  for (const line of markdown.split('\n')) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      if (cur.text.trim() || cur.level > 0) sections.push({ ...cur, text: cur.text.trim() });
      cur = { heading: m[2]!.trim(), level: m[1]!.length, text: '' };
    } else cur.text += line + '\n';
  }
  if (cur.text.trim() || cur.level > 0) sections.push({ ...cur, text: cur.text.trim() });
  return sections;
}

export function requirementIds(markdown: string, pattern: string): string[] {
  return [...new Set([...markdown.matchAll(new RegExp(`\\b${pattern}\\b`, 'g'))].map((m) => m[0]))];
}

/** The `topic-prd` artifact body: page metadata, the section index, and the fenced page content. */
export function prdArtifactBody(topic: string, page: ConfluencePage, requirementPattern = 'FR\\d+'): string {
  const md = pageToMarkdown(page.html);
  const sections = splitSections(md);
  const reqs = requirementIds(md, requirementPattern);
  return [
    `# PRD for ${topic}`,
    '',
    `- Page: ${page.url} (id ${page.id}, version ${page.version})`,
    `- Title: \`${page.title.replace(/`/g, "'")}\``,
    `- Sections: ${sections.map((s) => s.heading).join(' · ') || 'none'}`,
    `- Requirement ids: ${reqs.length ? reqs.join(', ') : 'none (trace to AC only)'}`,
    '',
    '## Content',
    '',
    fenceUntrusted(md, 'confluence'),
    '',
  ].join('\n');
}
