import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import type { DifitInstance } from './difit-manager.js';
import { detectBaseBranch, summarizeWorktree, type WorktreeSummary } from './git-summary.js';
import { renderDashboardHtml, renderReviewMarkdown } from './render.js';
import { listWorktrees, type Worktree } from './worktrees.js';

/** Interfaz mínima que el hub necesita del DifitManager (inyectable en tests). */
export interface DifitLauncher {
  ensure(wt: Worktree, base: string | null): Promise<DifitInstance>;
  liveUrl(wtId: string): string | null;
}

export interface HubContext {
  /** Raíz del repo desde el que se ejecutó wtv. */
  repoRoot: string;
  /** Override de rama base (flag --base). */
  base?: string;
  difit: DifitLauncher;
  /** Tope de bytes por diff en los endpoints agregados. */
  maxDiffBytes?: number;
}

export interface WorktreeReview {
  id: string;
  path: string;
  branch: string | null;
  head: string;
  detached: boolean;
  locked: boolean;
  isMain: boolean;
  dirty: boolean;
  summary: Omit<WorktreeSummary, 'diff' | 'dirty'>;
  /** Solo presente en /api/review.json y /review.md. */
  diff?: string;
  /** URL de la instancia difit viva para este worktree, si existe. */
  difitUrl: string | null;
}

export interface ReviewAggregate {
  repo: string;
  generatedAt: string;
  worktrees: WorktreeReview[];
}

export type HubApp = Hono;

async function aggregate(ctx: HubContext, includeDiff: boolean): Promise<ReviewAggregate> {
  const all = await listWorktrees(ctx.repoRoot);
  const wts = all.filter((w) => !w.bare);
  wts.sort((a, b) => Number(b.isMain) - Number(a.isMain) || (a.branch ?? a.id).localeCompare(b.branch ?? b.id));

  const worktrees = await Promise.all(
    wts.map(async (wt): Promise<WorktreeReview> => {
      const { diff, dirty, ...summary } = await summarizeWorktree(wt, {
        base: ctx.base,
        maxDiffBytes: ctx.maxDiffBytes,
      });
      return {
        id: wt.id,
        path: wt.path,
        branch: wt.branch,
        head: wt.head,
        detached: wt.detached,
        locked: wt.locked,
        isMain: wt.isMain,
        dirty,
        summary,
        ...(includeDiff ? { diff } : {}),
        difitUrl: ctx.difit.liveUrl(wt.id),
      };
    }),
  );

  return { repo: ctx.repoRoot, generatedAt: new Date().toISOString(), worktrees };
}

export function createHubApp(ctx: HubContext): HubApp {
  const app = new Hono();

  app.get('/', async (c) => {
    const data = await aggregate(ctx, false);
    return c.html(renderDashboardHtml(data));
  });

  app.get('/api/worktrees.json', async (c) => c.json(await aggregate(ctx, false)));

  app.get('/api/review.json', async (c) => c.json(await aggregate(ctx, true)));

  app.get('/review.md', async (c) => {
    const data = await aggregate(ctx, true);
    return c.text(renderReviewMarkdown(data), 200, { 'content-type': 'text/markdown; charset=utf-8' });
  });

  app.get('/wt/:id/open', async (c) => {
    const id = c.req.param('id');
    const wts = await listWorktrees(ctx.repoRoot);
    const wt = wts.find((w) => w.id === id && !w.bare);
    if (!wt) return c.text(`worktree desconocido: ${id}`, 404);
    const base = await detectBaseBranch(wt.path, ctx.base);
    const inst = await ctx.difit.ensure(wt, base);
    return c.redirect(inst.url, 302);
  });

  return app;
}

export function startHub(ctx: HubContext, opts: { port: number; host: string }): ServerType {
  const app = createHubApp(ctx);
  return serve({ fetch: app.fetch, port: opts.port, hostname: opts.host });
}
