import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { readRepoBase, readRepoMode, writeRepoBase, writeRepoMode, type ReviewMode } from './config.js';
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
  /** 'pr': diff completo del PR; 'wip': solo cambios sin commitear. */
  mode: ReviewMode;
  worktrees: WorktreeReview[];
}

export type HubApp = Hono;

/** Base efectiva: flag --base → config guardada del usuario → auto-detección (undefined). */
function resolveBaseOverride(ctx: HubContext): string | undefined {
  return ctx.base ?? readRepoBase(ctx.repoRoot) ?? undefined;
}

/** Modo efectivo: query ?mode=pr|wip → config guardada → 'pr'. */
function resolveMode(ctx: HubContext, queryMode?: string): ReviewMode {
  if (queryMode === 'pr' || queryMode === 'wip') return queryMode;
  return readRepoMode(ctx.repoRoot);
}

async function aggregate(ctx: HubContext, includeDiff: boolean, mode: ReviewMode): Promise<ReviewAggregate> {
  const all = await listWorktrees(ctx.repoRoot);
  const wts = all.filter((w) => !w.bare);
  wts.sort((a, b) => Number(b.isMain) - Number(a.isMain) || (a.branch ?? a.id).localeCompare(b.branch ?? b.id));

  const baseOverride = resolveBaseOverride(ctx);
  const worktrees = await Promise.all(
    wts.map(async (wt): Promise<WorktreeReview> => {
      const { diff, dirty, ...summary } = await summarizeWorktree(wt, {
        base: baseOverride,
        maxDiffBytes: ctx.maxDiffBytes,
        mode,
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

  return { repo: ctx.repoRoot, generatedAt: new Date().toISOString(), mode, worktrees };
}

export function createHubApp(ctx: HubContext): HubApp {
  const app = new Hono();

  app.get('/', async (c) => {
    const mode = resolveMode(ctx, c.req.query('mode'));
    const data = await aggregate(ctx, false, mode);
    const branches = (await runGit(['branch', '--format=%(refname:short)'], ctx.repoRoot))
      .split('\n')
      .filter(Boolean);
    const effectiveBase = resolveBaseOverride(ctx) ?? (await detectBaseBranch(ctx.repoRoot));
    return c.html(renderDashboardHtml(data, { branches, effectiveBase, baseLocked: Boolean(ctx.base), mode }));
  });

  app.post('/api/mode', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { mode?: unknown };
    const mode = body.mode;
    if (mode !== 'pr' && mode !== 'wip') return c.json({ error: 'mode debe ser "pr" o "wip"' }, 400);
    writeRepoMode(ctx.repoRoot, mode);
    await ctx.difit.stopAll(); // las instancias vivas quedaron con el modo viejo
    return c.json({ ok: true, mode });
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

  app.get('/api/worktrees.json', async (c) =>
    c.json(await aggregate(ctx, false, resolveMode(ctx, c.req.query('mode')))),
  );

  app.get('/api/review.json', async (c) =>
    c.json(await aggregate(ctx, true, resolveMode(ctx, c.req.query('mode')))),
  );

  app.get('/review.md', async (c) => {
    const data = await aggregate(ctx, true, resolveMode(ctx, c.req.query('mode')));
    return c.text(renderReviewMarkdown(data), 200, { 'content-type': 'text/markdown; charset=utf-8' });
  });

  app.get('/wt/:id/open', async (c) => {
    const id = c.req.param('id');
    const wts = await listWorktrees(ctx.repoRoot);
    const wt = wts.find((w) => w.id === id && !w.bare);
    if (!wt) return c.text(`worktree desconocido: ${id}`, 404);
    const mode = resolveMode(ctx, c.req.query('mode'));
    // wip → sin base: difit diffea working tree contra HEAD (solo sin commitear)
    const base = mode === 'wip' ? null : await detectBaseBranch(wt.path, resolveBaseOverride(ctx));
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
