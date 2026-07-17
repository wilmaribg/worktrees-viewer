import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import {
  readRepoBase,
  readRepoMode,
  readRepoRunCommand,
  readRepoWorktreeRunCommand,
  writeRepoBase,
  writeRepoMode,
  writeRepoRunCommand,
  writeRepoWorktreeRunCommand,
  type ReviewMode,
} from './config.js';
import type { DifitInstance } from './difit-manager.js';
import { createPullRequest, type PrResult } from './pr.js';
import type { RunStatus } from './run-manager.js';
import { detectBaseBranch, summarizeWorktree, type WorktreeSummary } from './git-summary.js';
import { runGit, tryGit } from './git.js';
import { renderDashboardHtml, renderReviewMarkdown } from './render.js';
import { listWorktrees, type Worktree } from './worktrees.js';

/** Interfaz mínima que el hub necesita del DifitManager (inyectable en tests). */
export interface DifitLauncher {
  ensure(wt: Worktree, base: string | null): Promise<DifitInstance>;
  liveUrl(wtId: string): string | null;
  stop(wtId: string): Promise<void>;
  stopAll(): Promise<void>;
}

/** Interfaz mínima que el hub necesita del RunManager (inyectable en tests). */
export interface RunLauncher {
  start(wt: Worktree, command: string): RunStatus;
  status(wtId: string): RunStatus | null;
  stop(wtId: string): Promise<void>;
  stopAll(): Promise<void>;
}

export interface HubContext {
  /** Raíz del repo desde el que se ejecutó wtv. */
  repoRoot: string;
  /** Override de rama base (flag --base). */
  base?: string;
  difit: DifitLauncher;
  run: RunLauncher;
  /** Crea el PR (push + gh). Inyectable en tests; por defecto usa gh CLI. */
  createPr?: (wt: Worktree, base: string | null) => Promise<PrResult>;
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
  /** Estado del comando de arranque (dev server) para este worktree. */
  run: { running: boolean; url: string | null; pid: number | null; exitCode: number | null } | null;
  /** Comando propio de este worktree (monorepo), o null si usa el general. */
  runCommandOverride: string | null;
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
        run: toRunInfo(ctx.run.status(wt.id)),
        runCommandOverride: readRepoWorktreeRunCommand(ctx.repoRoot, wt.id),
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
    return c.html(
      renderDashboardHtml(data, {
        branches,
        effectiveBase,
        baseLocked: Boolean(ctx.base),
        mode,
        runCommand: readRepoRunCommand(ctx.repoRoot),
      }),
    );
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
    const wt = await findWorktree(ctx, id);
    if (!wt) return c.text(`worktree desconocido: ${id}`, 404);
    const mode = resolveMode(ctx, c.req.query('mode'));
    // wip → sin base: difit diffea working tree contra HEAD (solo sin commitear)
    const base = mode === 'wip' ? null : await detectBaseBranch(wt.path, resolveBaseOverride(ctx));
    const inst = await ctx.difit.ensure(wt, base);
    return c.redirect(inst.url, 302);
  });

  app.post('/api/run-command', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { command?: unknown };
    const command = typeof body.command === 'string' ? body.command.trim() : '';
    if (!command) return c.json({ error: 'falta "command"' }, 400);
    writeRepoRunCommand(ctx.repoRoot, command);
    return c.json({ ok: true, command });
  });

  // Override de comando por worktree (monorepo). Vacío → borra el override.
  app.post('/wt/:id/run-command', async (c) => {
    const id = c.req.param('id');
    const wt = await findWorktree(ctx, id);
    if (!wt) return c.text(`worktree desconocido: ${id}`, 404);
    const body = (await c.req.json().catch(() => ({}))) as { command?: unknown };
    const command = typeof body.command === 'string' ? body.command.trim() : '';
    writeRepoWorktreeRunCommand(ctx.repoRoot, id, command || null);
    return c.json({ ok: true, command: command || null });
  });

  app.post('/wt/:id/run/start', async (c) => {
    const id = c.req.param('id');
    const wt = await findWorktree(ctx, id);
    if (!wt) return c.text(`worktree desconocido: ${id}`, 404);
    // override propio del worktree → comando general del repo
    const command = readRepoWorktreeRunCommand(ctx.repoRoot, id) ?? readRepoRunCommand(ctx.repoRoot);
    if (!command) {
      return c.json({ error: 'no hay comando de arranque configurado; defínelo en el dashboard' }, 400);
    }
    return c.json(ctx.run.start(wt, command));
  });

  app.get('/wt/:id/run', (c) => c.json(ctx.run.status(c.req.param('id'))));

  app.get('/wt/:id/run/logs', (c) => {
    const status = ctx.run.status(c.req.param('id'));
    if (!status) return c.text('sin proceso para este worktree', 404);
    return c.text(status.logs, 200, { 'content-type': 'text/plain; charset=utf-8' });
  });

  app.post('/wt/:id/run/stop', async (c) => {
    await ctx.run.stop(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.post('/wt/:id/pr', async (c) => {
    const wt = await findWorktree(ctx, c.req.param('id'));
    if (!wt) return c.text(`worktree desconocido: ${c.req.param('id')}`, 404);
    if (!wt.branch) return c.json({ error: 'worktree en detached HEAD: no hay rama para el PR' }, 400);

    // gh espera el nombre de rama sin remoto ("origin/main" → "main")
    const rawBase = resolveBaseOverride(ctx) ?? (await detectBaseBranch(wt.path)) ?? null;
    const base = rawBase?.replace(/^origin\//, '') ?? null;
    if (base && wt.branch === base) {
      return c.json({ error: `"${base}" es la rama base; no hay PR que crear desde ella` }, 400);
    }

    const dirty = (await runGit(['status', '--porcelain'], wt.path)).length > 0;
    try {
      const result = await (ctx.createPr ?? createPullRequest)(wt, base);
      return c.json({
        ok: true,
        ...result,
        ...(dirty ? { warning: 'hay cambios sin commitear que NO van en el PR' } : {}),
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post('/wt/:id/delete', async (c) => {
    const id = c.req.param('id');
    const wt = await findWorktree(ctx, id);
    if (!wt) return c.text(`worktree desconocido: ${id}`, 404);
    if (wt.isMain) return c.json({ error: 'el worktree principal no se puede eliminar' }, 400);

    const body = (await c.req.json().catch(() => ({}))) as { deleteBranch?: unknown; force?: unknown };
    const force = body.force === true;
    const deleteBranch = body.deleteBranch === true;

    const dirty = (await runGit(['status', '--porcelain'], wt.path)).length > 0;
    if (dirty && !force) {
      return c.json({ error: 'el worktree tiene cambios sin commitear', requiresForce: true }, 409);
    }

    // apagar procesos que usan el directorio antes de borrarlo
    await ctx.run.stop(id);
    await ctx.difit.stop(id);

    try {
      await runGit(['worktree', 'remove', ...(force ? ['--force'] : []), wt.path], ctx.repoRoot);
      let branchDeleted = false;
      if (deleteBranch && wt.branch) {
        await runGit(['branch', '-D', wt.branch], ctx.repoRoot);
        branchDeleted = true;
      }
      await tryGit(['worktree', 'prune'], ctx.repoRoot);
      return c.json({ ok: true, branchDeleted });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  return app;
}

async function findWorktree(ctx: HubContext, id: string): Promise<Worktree | undefined> {
  const wts = await listWorktrees(ctx.repoRoot);
  return wts.find((w) => w.id === id && !w.bare);
}

function toRunInfo(status: RunStatus | null): WorktreeReview['run'] {
  if (!status) return null;
  return { running: status.running, url: status.url, pid: status.pid, exitCode: status.exitCode };
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
