import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { readRepoBase, writeRepoBase } from './config.js';
import type { DifitInstance } from './difit-manager.js';
import { detectBaseBranch, summarizeWorktree, type WorktreeSummary } from './git-summary.js';
import { runGit, tryGit } from './git.js';
import { renderDashboardHtml, renderReviewMarkdown } from './render.js';
import { listWorktrees, type Worktree } from './worktrees.js';

/** Interfaz mínima que el hub necesita del DifitManager (inyectable en tests). */
export interface DifitLauncher {
  ensure(wt: Worktree, base: string | null): Promise<DifitInstance>;
  liveUrl(wtId: string): string | null;
  stopAll(): Promise<void>;
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

/** Base efectiva: flag --base → config guardada del usuario → auto-detección (undefined). */
function resolveBaseOverride(ctx: HubContext): string | undefined {
  return ctx.base ?? readRepoBase(ctx.repoRoot) ?? undefined;
}

async function aggregate(ctx: HubContext, includeDiff: boolean): Promise<ReviewAggregate> {
  const all = await listWorktrees(ctx.repoRoot);
  const wts = all.filter((w) => !w.bare);
  wts.sort((a, b) => Number(b.isMain) - Number(a.isMain) || (a.branch ?? a.id).localeCompare(b.branch ?? b.id));

  const baseOverride = resolveBaseOverride(ctx);
  const worktrees = await Promise.all(
    wts.map(async (wt): Promise<WorktreeReview> => {
      const { diff, dirty, ...summary } = await summarizeWorktree(wt, {
        base: baseOverride,
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
    const branches = (await runGit(['branch', '--format=%(refname:short)'], ctx.repoRoot))
      .split('\n')
      .filter(Boolean);
    const effectiveBase = resolveBaseOverride(ctx) ?? (await detectBaseBranch(ctx.repoRoot));
    return c.html(renderDashboardHtml(data, { branches, effectiveBase, baseLocked: Boolean(ctx.base) }));
  });

  app.post('/api/base', async (c) => {
    if (ctx.base) {
      return c.json({ error: 'la base está fijada por el flag --base; relanza sin él para cambiarla' }, 409);
    }
    const body = (await c.req.json().catch(() => ({}))) as { base?: unknown };
    const base = typeof body.base === 'string' ? body.base.trim() : '';
    if (!base) return c.json({ error: 'falta "base"' }, 400);
    const exists = await tryGit(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], ctx.repoRoot);
    if (exists === null) return c.json({ error: `la rama "${base}" no existe en el repo` }, 400);
    writeRepoBase(ctx.repoRoot, base);
    await ctx.difit.stopAll(); // las instancias vivas quedaron calculadas con la base vieja
    return c.json({ ok: true, base });
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
    const base = await detectBaseBranch(wt.path, resolveBaseOverride(ctx));
    const inst = await ctx.difit.ensure(wt, base);
    return c.redirect(inst.url, 302);
  });

  return app;
}

export function startHub(
  ctx: HubContext,
  opts: { port: number; host: string; onListen?: (info: { port: number; address: string }) => void },
): ServerType {
  const app = createHubApp(ctx);
  return serve({ fetch: app.fetch, port: opts.port, hostname: opts.host }, (info) => {
    opts.onListen?.({ port: info.port, address: info.address });
  });
}
