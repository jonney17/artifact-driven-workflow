export interface ConfluencePage {
  id: string;
  title: string;
  version: number;
  /** Storage-format XHTML. */
  html: string;
  url: string;
}

/** Read-only Confluence access (the PRD is never edited by the workflow). */
export interface ConfluenceApi {
  getPage(id: string): Promise<ConfluencePage | undefined>;
}

/** In-memory Confluence for tests. */
export class FakeConfluence implements ConfluenceApi {
  readonly pages = new Map<string, ConfluencePage>();

  put(id: string, title: string, html: string): ConfluencePage {
    const version = (this.pages.get(id)?.version ?? 0) + 1;
    const page = { id, title, version, html, url: `https://wiki.test/pages/viewpage.action?pageId=${id}` };
    this.pages.set(id, page);
    return page;
  }

  async getPage(id: string) {
    return this.pages.get(id);
  }
}

/**
 * Confluence REST client (`/rest/api/content/{id}?expand=body.storage,version`).
 * NOT YET VERIFIED against the team's Confluence: Atlassian spike.
 */
export class ConfluenceRestClient implements ConfluenceApi {
  constructor(private readonly o: { site: string; auth: { email: string; token: string } | { bearer: string }; fetch?: typeof fetch }) {}

  async getPage(id: string): Promise<ConfluencePage | undefined> {
    const auth = 'bearer' in this.o.auth ? `Bearer ${this.o.auth.bearer}` : `Basic ${Buffer.from(`${this.o.auth.email}:${this.o.auth.token}`).toString('base64')}`;
    const base = this.o.site.replace(/\/$/, '');
    const res = await (this.o.fetch ?? fetch)(`${base}/rest/api/content/${encodeURIComponent(id)}?expand=body.storage,version`, {
      headers: { Accept: 'application/json', Authorization: auth },
    });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`Confluence GET ${id}: ${res.status}`);
    const r = (await res.json()) as any;
    return { id: r.id, title: r.title, version: r.version?.number ?? 1, html: r.body?.storage?.value ?? '', url: `${base}${r._links?.webui ?? ''}` };
  }
}
