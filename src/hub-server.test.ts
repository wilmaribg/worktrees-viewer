import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  isWorktreeArchived,
  readRepoBase,
  readRepoRunCommand,
  readRepoSort,
  readRepoWorktreeRunCommand,
} from './config.js';
import type { DifitInstance } from './difit-manager.js';
import { createHubApp, type HubApp } from './hub-server.js';
import type { PrInfo } from './pr.js';
import type { RunStatus } from './run-manager.js';
import { createFixture, type Fixture } from './test-fixture.js';
import type { Worktree } from './worktrees.js';

let fx: Fixture;
let app: HubApp;
let tmpConfigHome: string;
const prevXdg = process.env['XDG_CONFIG_HOME'];
const ensured: Array<{ wt: Worktree; base: string | null }> = [];
let stopAllCalls = 0;

const fakeDifit = {
  async ensure(wt: Worktree, base: string | null): Promise<DifitInstance> {
    ensured.push({ wt, base });
    return { url: 'http://localhost:9999', port: 9999, pid: 12345 };
  },
  liveUrl(): string | null {
    return null;
  },
  async stop(wtId: string): Promise<void> {
    difitStopped.push(wtId);
  },
  async stopAll(): Promise<void> {
    stopAllCalls++;
  },
};
const difitStopped: string[] = [];

const runStarted: Array<{ wt: Worktree; command: string }> = [];
const runStopped: string[] = [];
const runStatuses = new Map<string, RunStatus>();

function fakeRunStatus(overrides: Partial<RunStatus> = {}): RunStatus {
  return {
    running: true,
    pid: 4242,
    url: 'http://localhost:9000/',
    command: 'npm run dev',
    startedAt: '2026-01-01T00:00:00.000Z',
    exitCode: null,
    logs: 'App corriendo en http://localhost:9000/',
    ...overrides,
  };
}

const fakeRun = {
  start(wt: Worktree, command: string): RunStatus {
    runStarted.push({ wt, command });
    const status = fakeRunStatus({ command });
    runStatuses.set(wt.id, status);
    return status;
  },
  status(wtId: string): RunStatus | null {
    return runStatuses.get(wtId) ?? null;
  },
  async stop(wtId: string): Promise<void> {
    runStopped.push(wtId);
    runStatuses.delete(wtId);
  },
  async stopAll(): Promise<void> {
    runStatuses.clear();
  },
};

// PR por rama para tests (vacío → lookup null, sin spawnear gh real)
const fakePrs = new Map<string, PrInfo>();

// rutas abiertas en el editor (fake de openEditor)
const editorOpened: string[] = [];

beforeAll(() => {
  tmpConfigHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wtv-hub-config-'));
  process.env['XDG_CONFIG_HOME'] = tmpConfigHome;
  fx = createFixture();
  app = createHubApp({
    repoRoot: fx.repo,
    difit: fakeDifit,
    run: fakeRun,
    lookupPr: async (branch: string) => fakePrs.get(branch) ?? null,
    openEditor: async (p: string) => {
      editorOpened.push(p);
    },
  });
});

afterAll(() => {
  if (prevXdg === undefined) delete process.env['XDG_CONFIG_HOME'];
  else process.env['XDG_CONFIG_HOME'] = prevXdg;
  fs.rmSync(tmpConfigHome, { recursive: true, force: true });
  fx.cleanup();
});

describe('hub endpoints', () => {
  test('GET /api/worktrees.json lista todos los worktrees con resumen sin diff', async () => {
    const res = await app.request('/api/worktrees.json');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repo: string; worktrees: Array<Record<string, unknown>> };
    expect(body.worktrees.length).toBeGreaterThanOrEqual(5);
    const branches = body.worktrees.map((w) => w['branch']);
    expect(branches).toContain('feat-a');
    expect(branches).toContain('feat-b');
    const featB = body.worktrees.find((w) => w['branch'] === 'feat-b')!;
    expect(featB['dirty']).toBe(true);
    expect(featB['summary']).toBeDefined();
    expect(JSON.stringify(featB)).not.toContain('WIP sin commitear'); // sin diff
  });

  test('GET /api/review.json agrega los diffs de todos los worktrees', async () => {
    const res = await app.request('/api/review.json');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { worktrees: Array<{ branch: string | null; diff: string }> };
    const featB = body.worktrees.find((w) => w.branch === 'feat-b')!;
    expect(featB.diff).toContain('WIP sin commitear');
    expect(featB.diff).toContain('nuevo.js');
  });

  test('GET /review.md agrega todo en markdown', async () => {
    const res = await app.request('/review.md');
    expect(res.status).toBe(200);
    const md = await res.text();
    expect(md).toContain('# Revisión de worktrees');
    expect(md).toContain('feat-a');
    expect(md).toContain('```diff');
    expect(md).toContain('WIP sin commitear');
  });

  test('GET /wt/:id/open lanza difit y redirige 302', async () => {
    const list = await app.request('/api/worktrees.json');
    const body = (await list.json()) as { worktrees: Array<{ id: string; branch: string | null }> };
    const featA = body.worktrees.find((w) => w.branch === 'feat-a')!;

    ensured.length = 0;
    const res = await app.request(`/wt/${featA.id}/open`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://localhost:9999');
    expect(ensured).toHaveLength(1);
    expect(ensured[0]?.wt.branch).toBe('feat-a');
    expect(ensured[0]?.base).toBe('main');
  });

  test('GET /wt/desconocido/open responde 404', async () => {
    const res = await app.request('/wt/no-existe/open');
    expect(res.status).toBe(404);
  });

  test('GET / devuelve el dashboard HTML', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('feat-a');
    expect(html).toContain('feat-b');
    expect(html).toContain('/api/review.json');
  });
});

describe('rama base configurable', () => {
  test('el dashboard muestra un selector con las ramas locales y la base efectiva', async () => {
    const html = await (await app.request('/')).text();
    expect(html).toContain('<select id="base-select"');
    expect(html).toContain('<option value="feat-clean"');
    expect(html).toMatch(/<option value="main"[^>]*selected/); // base auto-detectada
  });

  test('POST /api/base rechaza ramas inexistentes con 400', async () => {
    const res = await app.request('/api/base', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ base: 'no-existe' }),
    });
    expect(res.status).toBe(400);
    expect(readRepoBase(fx.repo)).toBeNull();
  });

  test('POST /api/base persiste, apaga difit y cambia la base efectiva', async () => {
    stopAllCalls = 0;
    const res = await app.request('/api/base', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ base: 'feat-a' }),
    });
    expect(res.status).toBe(200);
    expect(readRepoBase(fx.repo)).toBe('feat-a');
    expect(stopAllCalls).toBe(1);

    // la nueva base se aplica al agregado: wt-a ya no está ahead de sí misma
    const body = (await (await app.request('/api/worktrees.json')).json()) as {
      worktrees: Array<{ branch: string | null; summary: { baseBranch: string | null; ahead: number } }>;
    };
    const featA = body.worktrees.find((w) => w.branch === 'feat-a')!;
    expect(featA.summary.baseBranch).toBe('feat-a');
    expect(featA.summary.ahead).toBe(0);

    // y el selector la marca
    const html = await (await app.request('/')).text();
    expect(html).toMatch(/<option value="feat-a"[^>]*selected/);
  });

  test('el flag --base tiene precedencia sobre la config guardada', async () => {
    const flagApp = createHubApp({ repoRoot: fx.repo, base: 'main', difit: fakeDifit, run: fakeRun });
    const body = (await (await flagApp.request('/api/worktrees.json')).json()) as {
      worktrees: Array<{ branch: string | null; summary: { baseBranch: string | null } }>;
    };
    expect(body.worktrees.find((w) => w.branch === 'feat-a')!.summary.baseBranch).toBe('main');
  });
});

interface WtLight {
  id: string;
  branch: string | null;
  summary: { files: Array<{ path: string }> };
}

describe('modo PR / solo sin commitear', () => {
  beforeAll(async () => {
    // el bloque anterior dejó la base en feat-a; este bloque asume main
    await app.request('/api/base', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ base: 'main' }),
    });
  });

  test('el dashboard muestra el toggle con "pr" activo por defecto', async () => {
    const html = await (await app.request('/')).text();
    expect(html).toContain('id="mode-toggle"');
    expect(html).toMatch(/value="pr"[^>]*checked/);
  });

  test('POST /api/mode rechaza modos inválidos', async () => {
    const res = await app.request('/api/mode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'otra-cosa' }),
    });
    expect(res.status).toBe(400);
  });

  test('POST /api/mode wip persiste, apaga difit y cambia los resúmenes', async () => {
    stopAllCalls = 0;
    const res = await app.request('/api/mode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'wip' }),
    });
    expect(res.status).toBe(200);
    expect(stopAllCalls).toBe(1);

    const body = (await (await app.request('/api/worktrees.json')).json()) as { worktrees: WtLight[] };
    // feat-a: todo committeado → 0 archivos en wip
    expect(body.worktrees.find((w) => w.branch === 'feat-a')!.summary.files).toEqual([]);
    // feat-b: WIP + untracked
    const featB = body.worktrees.find((w) => w.branch === 'feat-b')!;
    expect(featB.summary.files.map((f) => f.path).sort()).toEqual(['README.md', 'nuevo.js']);

    const html = await (await app.request('/')).text();
    expect(html).toMatch(/value="wip"[^>]*checked/);
  });

  test('en modo wip, abrir difit no pasa base (diff contra HEAD)', async () => {
    const list = (await (await app.request('/api/worktrees.json')).json()) as { worktrees: WtLight[] };
    const featB = list.worktrees.find((w) => w.branch === 'feat-b')!;
    ensured.length = 0;
    const res = await app.request(`/wt/${featB.id}/open`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(ensured[0]?.base).toBeNull();
  });

  test('?mode=pr fuerza el modo PR aunque la config diga wip', async () => {
    const body = (await (await app.request('/api/worktrees.json?mode=pr')).json()) as { worktrees: WtLight[] };
    const featB = body.worktrees.find((w) => w.branch === 'feat-b')!;
    // en PR vuelve a incluir lo committeado (README) y sigue el untracked
    expect(featB.summary.files.length).toBeGreaterThanOrEqual(2);
    const featA = body.worktrees.find((w) => w.branch === 'feat-a')!;
    expect(featA.summary.files.map((f) => f.path)).toEqual(['lib.js']);
  });
});

describe('levantar el proyecto', () => {
  async function wtId(branch: string): Promise<string> {
    const body = (await (await app.request('/api/worktrees.json')).json()) as {
      worktrees: Array<{ id: string; branch: string | null }>;
    };
    return body.worktrees.find((w) => w.branch === branch)!.id;
  }

  test('POST /api/run-command persiste el comando del repo', async () => {
    const res = await app.request('/api/run-command', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'npm run dev' }),
    });
    expect(res.status).toBe(200);
    expect(readRepoRunCommand(fx.repo)).toBe('npm run dev');
  });

  test('POST /api/run-command vacío responde 400', async () => {
    const res = await app.request('/api/run-command', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: '   ' }),
    });
    expect(res.status).toBe(400);
  });

  test('POST /api/run/:id/start lanza el comando configurado', async () => {
    const id = await wtId('feat-a');
    runStarted.length = 0;
    const res = await app.request(`/wt/${id}/run/start`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RunStatus;
    expect(body.running).toBe(true);
    expect(body.url).toBe('http://localhost:9000/');
    expect(runStarted).toHaveLength(1);
    expect(runStarted[0]?.wt.branch).toBe('feat-a');
    expect(runStarted[0]?.command).toBe('npm run dev');
  });

  test('GET /wt/:id/run devuelve el estado actual', async () => {
    const id = await wtId('feat-a');
    const res = await app.request(`/wt/${id}/run`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as RunStatus;
    expect(body.pid).toBe(4242);
  });

  test('GET /wt/:id/run sin proceso devuelve null', async () => {
    const id = await wtId('feat-clean');
    const res = await app.request(`/wt/${id}/run`);
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  test('GET /wt/:id/run/logs devuelve texto plano', async () => {
    const id = await wtId('feat-a');
    const res = await app.request(`/wt/${id}/run/logs`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toContain('App corriendo');
  });

  test('POST /wt/:id/run/stop detiene el proceso', async () => {
    const id = await wtId('feat-a');
    runStopped.length = 0;
    const res = await app.request(`/wt/${id}/run/stop`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(runStopped).toEqual([id]);
  });

  test('start sin comando configurado responde 400', async () => {
    fs.rmSync(configPathIn(tmpConfigHome), { force: true });
    const id = await wtId('feat-a');
    const res = await app.request(`/wt/${id}/run/start`, { method: 'POST' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('comando');
  });

  test('start sobre un worktree desconocido responde 404', async () => {
    const res = await app.request('/wt/no-existe/run/start', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

function configPathIn(configHome: string): string {
  return path.join(configHome, 'wtv', 'config.json');
}

describe('comando por worktree (monorepo)', () => {
  async function wtId(branch: string): Promise<string> {
    const body = (await (await app.request('/api/worktrees.json')).json()) as {
      worktrees: Array<{ id: string; branch: string | null }>;
    };
    return body.worktrees.find((w) => w.branch === branch)!.id;
  }

  beforeAll(async () => {
    // el bloque anterior borró la config: reponer el comando general
    await app.request('/api/run-command', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'npm run dev' }),
    });
  });

  afterAll(async () => {
    await fakeRun.stopAll(); // no dejar procesos vivos para el bloque siguiente
  });

  test('el agregado expone el override por worktree (null por defecto)', async () => {
    const body = (await (await app.request('/api/worktrees.json')).json()) as {
      worktrees: Array<{ branch: string | null; runCommandOverride: string | null }>;
    };
    expect(body.worktrees.find((w) => w.branch === 'feat-a')!.runCommandOverride).toBeNull();
  });

  test('POST /wt/:id/run-command guarda un override propio', async () => {
    const id = await wtId('feat-a');
    const res = await app.request(`/wt/${id}/run-command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'cd apps/api && npm start' }),
    });
    expect(res.status).toBe(200);
    expect(readRepoWorktreeRunCommand(fx.repo, id)).toBe('cd apps/api && npm start');

    const body = (await (await app.request('/api/worktrees.json')).json()) as {
      worktrees: Array<{ id: string; runCommandOverride: string | null }>;
    };
    expect(body.worktrees.find((w) => w.id === id)!.runCommandOverride).toBe('cd apps/api && npm start');
  });

  test('start usa el override del worktree, no el general', async () => {
    const id = await wtId('feat-a');
    runStarted.length = 0;
    const res = await app.request(`/wt/${id}/run/start`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(runStarted[0]?.command).toBe('cd apps/api && npm start');
  });

  test('otros worktrees siguen usando el comando general', async () => {
    const id = await wtId('feat-b');
    runStarted.length = 0;
    await app.request(`/wt/${id}/run/start`, { method: 'POST' });
    expect(runStarted[0]?.command).toBe('npm run dev');
  });

  test('POST /wt/:id/run-command vacío borra el override (vuelve al general)', async () => {
    const id = await wtId('feat-a');
    const res = await app.request(`/wt/${id}/run-command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: '  ' }),
    });
    expect(res.status).toBe(200);
    expect(readRepoWorktreeRunCommand(fx.repo, id)).toBeNull();

    runStarted.length = 0;
    await app.request(`/wt/${id}/run/start`, { method: 'POST' });
    expect(runStarted[0]?.command).toBe('npm run dev');
  });

  test('run-command sobre worktree desconocido responde 404', async () => {
    const res = await app.request('/wt/no-existe/run-command', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'x' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('crear pull request', () => {
  const prCalls: Array<{ wt: Worktree; base: string | null }> = [];
  let prApp: HubApp;

  beforeAll(() => {
    prApp = createHubApp({
      repoRoot: fx.repo,
      difit: fakeDifit,
      run: fakeRun,
      createPr: async (wt, base) => {
        prCalls.push({ wt, base });
        return { url: 'https://github.com/acme/repo/pull/7', created: true };
      },
    });
  });

  async function wtByBranch(branch: string | null, opts: { main?: boolean } = {}): Promise<{ id: string; dirty: boolean }> {
    const body = (await (await prApp.request('/api/worktrees.json')).json()) as {
      worktrees: Array<{ id: string; branch: string | null; isMain: boolean; dirty: boolean }>;
    };
    const wt = body.worktrees.find((w) => (opts.main ? w.isMain : w.branch === branch))!;
    return { id: wt.id, dirty: wt.dirty };
  }

  test('POST /wt/:id/pr crea el PR contra la base efectiva', async () => {
    const { id } = await wtByBranch('feat-a');
    prCalls.length = 0;
    const res = await prApp.request(`/wt/${id}/pr`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; url: string; created: boolean; warning?: string };
    expect(body.ok).toBe(true);
    expect(body.url).toBe('https://github.com/acme/repo/pull/7');
    expect(body.created).toBe(true);
    expect(body.warning).toBeUndefined();
    expect(prCalls).toHaveLength(1);
    expect(prCalls[0]?.wt.branch).toBe('feat-a');
    expect(prCalls[0]?.base).toBe('main');
  });

  test('con cambios sin commitear el PR se crea pero avisa', async () => {
    const { id } = await wtByBranch('feat-b');
    const res = await prApp.request(`/wt/${id}/pr`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { warning?: string };
    expect(body.warning).toContain('sin commitear');
  });

  test('un worktree detached no puede crear PR', async () => {
    const { id } = await wtByBranch(null);
    prCalls.length = 0;
    const res = await prApp.request(`/wt/${id}/pr`, { method: 'POST' });
    expect(res.status).toBe(400);
    expect(prCalls).toHaveLength(0);
  });

  test('la rama base no puede abrir PR contra sí misma', async () => {
    const { id } = await wtByBranch(null, { main: true });
    const res = await prApp.request(`/wt/${id}/pr`, { method: 'POST' });
    expect(res.status).toBe(400);
  });

  test('si gh falla, responde 500 con el error', async () => {
    const failApp = createHubApp({
      repoRoot: fx.repo,
      difit: fakeDifit,
      run: fakeRun,
      createPr: async () => {
        throw new Error('gh explotó');
      },
    });
    const { id } = await wtByBranch('feat-a');
    const res = await failApp.request(`/wt/${id}/pr`, { method: 'POST' });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('gh explotó');
  });
});

describe('eliminar worktree', () => {
  let counter = 0;

  /** Crea un worktree desechable con su rama; devuelve su id en el hub. */
  async function addDisposable(opts: { dirty?: boolean } = {}): Promise<{ id: string; branch: string; dir: string }> {
    counter++;
    const branch = `feat-borrar-${counter}`;
    const dir = path.join(fx.root, `wt-borrar-${counter}`);
    execFileSync('git', ['worktree', 'add', '-b', branch, dir, 'main'], { cwd: fx.repo, stdio: 'ignore' });
    if (opts.dirty) fs.writeFileSync(path.join(dir, 'sucio.txt'), 'sin commitear\n');
    const body = (await (await app.request('/api/worktrees.json')).json()) as {
      worktrees: Array<{ id: string; branch: string | null }>;
    };
    return { id: body.worktrees.find((w) => w.branch === branch)!.id, branch, dir };
  }

  async function listedBranches(): Promise<Array<string | null>> {
    const body = (await (await app.request('/api/worktrees.json')).json()) as {
      worktrees: Array<{ branch: string | null }>;
    };
    return body.worktrees.map((w) => w.branch);
  }

  function localBranches(): string {
    return execFileSync('git', ['branch', '--list'], { cwd: fx.repo, encoding: 'utf8' });
  }

  test('elimina el worktree y conserva la rama por defecto', async () => {
    const { id, branch } = await addDisposable();
    difitStopped.length = 0;
    runStopped.length = 0;
    const res = await app.request(`/wt/${id}/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as object).toMatchObject({ ok: true, branchDeleted: false });
    expect(await listedBranches()).not.toContain(branch);
    expect(localBranches()).toContain(branch);
    // apagó los procesos asociados antes de borrar
    expect(difitStopped).toEqual([id]);
    expect(runStopped).toEqual([id]);
  });

  test('con deleteBranch también borra la rama local', async () => {
    const { id, branch } = await addDisposable();
    const res = await app.request(`/wt/${id}/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deleteBranch: true }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as object).toMatchObject({ ok: true, branchDeleted: true });
    expect(localBranches()).not.toContain(branch);
  });

  test('worktree sucio: 409 sin force, borra con force', async () => {
    const { id, dir } = await addDisposable({ dirty: true });
    const res409 = await app.request(`/wt/${id}/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res409.status).toBe(409);
    expect((await res409.json()) as object).toMatchObject({ requiresForce: true });
    expect(fs.existsSync(dir)).toBe(true);

    const resForce = await app.request(`/wt/${id}/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: true, deleteBranch: true }),
    });
    expect(resForce.status).toBe(200);
    expect(fs.existsSync(dir)).toBe(false);
  });

  test('el worktree principal no se puede eliminar', async () => {
    const body = (await (await app.request('/api/worktrees.json')).json()) as {
      worktrees: Array<{ id: string; isMain: boolean }>;
    };
    const main = body.worktrees.find((w) => w.isMain)!;
    const res = await app.request(`/wt/${main.id}/delete`, { method: 'POST' });
    expect(res.status).toBe(400);
  });

  test('worktree desconocido responde 404', async () => {
    const res = await app.request('/wt/no-existe/delete', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

describe('controles del dashboard (run / PR / eliminar)', () => {
  beforeAll(async () => {
    await app.request('/api/run-command', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'npm run dev' }),
    });
  });

  test('el agregado incluye el estado run de cada worktree', async () => {
    const list = (await (await app.request('/api/worktrees.json')).json()) as {
      worktrees: Array<{ id: string; branch: string | null; run: { running: boolean; url: string | null } | null }>;
    };
    const featA = list.worktrees.find((w) => w.branch === 'feat-a')!;
    expect(featA.run).toBeNull();

    runStatuses.set(featA.id, fakeRunStatus());
    const list2 = (await (await app.request('/api/worktrees.json')).json()) as typeof list;
    const featA2 = list2.worktrees.find((w) => w.branch === 'feat-a')!;
    expect(featA2.run).toMatchObject({ running: true, url: 'http://localhost:9000/' });
  });

  test('el dashboard muestra el input del comando dev con el valor guardado', async () => {
    const html = await (await app.request('/')).text();
    expect(html).toContain('id="run-command"');
    expect(html).toMatch(/id="run-command"[^>]*value="npm run dev"/);
  });

  test('la tarjeta con proceso corriendo muestra Abrir app y Detener; el resto Levantar', async () => {
    const html = await (await app.request('/')).text();
    // feat-a corre (estado seteado en el test anterior)
    expect(html).toContain('http://localhost:9000/');
    expect(html).toContain('Detener');
    expect(html).toContain('Levantar');
  });

  test('un worktree corriendo sin URL detectada muestra "arrancando…" y Detener', async () => {
    // estado exacto al que se cae apenas se arranca: el control de Detener debe estar
    // disponible aunque todavía no se haya detectado la URL del dev server.
    const id = (
      (await (await app.request('/api/worktrees.json')).json()) as {
        worktrees: Array<{ id: string; branch: string | null }>;
      }
    ).worktrees.find((w) => w.branch === 'feat-b')!.id;
    runStatuses.set(id, fakeRunStatus({ url: null }));
    try {
      const html = await (await app.request('/')).text();
      expect(html).toContain('arrancando…');
      expect(html).toContain(`data-action="stop" data-wt="${id}"`);
    } finally {
      runStatuses.delete(id);
    }
  });

  test('PR y Eliminar aparecen según el tipo de worktree', async () => {
    const html = await (await app.request('/')).text();
    // 5 worktrees: main (sin PR ni eliminar), detached (sin PR), feat-a/b/clean (todo)
    expect(html.match(/data-action="pr"/g)).toHaveLength(3);
    expect(html.match(/data-action="delete"/g)).toHaveLength(4);
    expect(html).toContain('id="delete-dialog"');
  });

  test('cada tarjeta tiene su input de comando con el general como placeholder', async () => {
    const id = (
      (await (await app.request('/api/worktrees.json')).json()) as {
        worktrees: Array<{ id: string; branch: string | null }>;
      }
    ).worktrees.find((w) => w.branch === 'feat-b')!.id;
    // ponerle un override para verificar que aparece como value
    await app.request(`/wt/${id}/run-command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'cd apps/web && npm run dev' }),
    });
    const html = await (await app.request('/')).text();
    // un input por-tarjeta con el placeholder = comando general
    expect(html.match(/class="wt-command"/g)?.length).toBeGreaterThanOrEqual(4);
    expect(html).toContain('placeholder="npm run dev"');
    expect(html).toContain('value="cd apps/web &amp;&amp; npm run dev"');
    // limpiar
    await app.request(`/wt/${id}/run-command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: '' }),
    });
  });
});

async function idOf(branch: string): Promise<string> {
  const list = (await (await app.request('/api/worktrees.json')).json()) as {
    worktrees: Array<{ id: string; branch: string | null }>;
  };
  return list.worktrees.find((w) => w.branch === branch)!.id;
}

describe('fechas, archivar y orden (daily)', () => {
  test('el agregado incluye createdAt, lastCommitAt, archived y pr', async () => {
    const list = (await (await app.request('/api/worktrees.json')).json()) as {
      worktrees: Array<{
        branch: string | null;
        createdAt: string | null;
        lastCommitAt: string | null;
        archived: boolean;
        pr: PrInfo | null;
      }>;
    };
    const featA = list.worktrees.find((w) => w.branch === 'feat-a')!;
    expect(featA.createdAt).not.toBeNull();
    expect(featA.lastCommitAt).not.toBeNull();
    expect(featA.archived).toBe(false);
    expect(featA.pr).toBeNull();
  });

  test('el pr aparece en el agregado cuando gh lo encuentra', async () => {
    fakePrs.set('feat-a', { url: 'https://github.com/acme/repo/pull/7', state: 'OPEN', number: 7 });
    try {
      const list = (await (await app.request('/api/worktrees.json')).json()) as {
        worktrees: Array<{ branch: string | null; pr: PrInfo | null }>;
      };
      const featA = list.worktrees.find((w) => w.branch === 'feat-a')!;
      expect(featA.pr).toEqual({ url: 'https://github.com/acme/repo/pull/7', state: 'OPEN', number: 7 });
    } finally {
      fakePrs.delete('feat-a');
    }
  });

  test('POST /wt/:id/archive marca y desmarca el worktree', async () => {
    const id = await idOf('feat-clean');
    const res = await app.request(`/wt/${id}/archive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ archived: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, archived: true });
    expect(isWorktreeArchived(fx.repo, id)).toBe(true);

    const list = (await (await app.request('/api/worktrees.json')).json()) as {
      worktrees: Array<{ id: string; archived: boolean }>;
    };
    expect(list.worktrees.find((w) => w.id === id)!.archived).toBe(true);

    // desarchivar
    await app.request(`/wt/${id}/archive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ archived: false }),
    });
    expect(isWorktreeArchived(fx.repo, id)).toBe(false);
  });

  test('POST /wt/:id/archive con worktree desconocido responde 404', async () => {
    const res = await app.request('/wt/no-existe/archive', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ archived: true }),
    });
    expect(res.status).toBe(404);
  });

  test('POST /api/sort persiste un orden válido y rechaza inválidos', async () => {
    const ok = await app.request('/api/sort', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sort: 'created-asc' }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, sort: 'created-asc' });
    expect(readRepoSort(fx.repo)).toBe('created-asc');

    const bad = await app.request('/api/sort', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sort: 'por-tamaño' }),
    });
    expect(bad.status).toBe(400);

    // restaurar default para no afectar otros tests
    await app.request('/api/sort', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sort: 'modified-desc' }),
    });
  });
});

async function setSort(sort: string): Promise<void> {
  await app.request('/api/sort', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sort }),
  });
}

async function setArchived(id: string, archived: boolean): Promise<void> {
  await app.request(`/wt/${id}/archive`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ archived }),
  });
}

describe('dashboard: orden, archivados, fechas y PR', () => {
  afterAll(async () => {
    await setSort('modified-desc');
  });

  test('tiene el control de orden con las cuatro opciones', async () => {
    const html = await (await app.request('/')).text();
    expect(html).toContain('id="sort-select"');
    expect(html).toContain('value="modified-desc"');
    expect(html).toContain('value="modified-asc"');
    expect(html).toContain('value="created-desc"');
    expect(html).toContain('value="created-asc"');
  });

  test('cada tarjeta muestra fechas y botón Archivar', async () => {
    const html = await (await app.request('/')).text();
    expect(html.match(/class="wt-dates"/g)?.length).toBeGreaterThanOrEqual(4);
    expect(html).toContain('data-action="archive"');
    expect(html).toContain('Archivar');
  });

  test('los worktrees archivados van a una sección colapsable', async () => {
    const id = await idOf('feat-clean');
    await setArchived(id, true);
    try {
      const html = await (await app.request('/')).text();
      expect(html).toContain('<details');
      expect(html).toContain('Archivados');
      expect(html).toContain('Desarchivar');
      // la tarjeta archivada vive dentro del <details>
      const detailsStart = html.indexOf('<details');
      expect(html.indexOf(`data-wt="${id}"`)).toBeGreaterThan(detailsStart);
    } finally {
      await setArchived(id, false);
    }
  });

  test('la tarjeta muestra el link al PR cuando existe', async () => {
    fakePrs.set('feat-a', { url: 'https://github.com/acme/repo/pull/7', state: 'OPEN', number: 7 });
    try {
      const html = await (await app.request('/')).text();
      expect(html).toContain('href="https://github.com/acme/repo/pull/7"');
      expect(html).toContain('#7');
    } finally {
      fakePrs.delete('feat-a');
    }
  });

  test('el orden del dashboard respeta el sort configurado', async () => {
    const a = await idOf('feat-a');
    const b = await idOf('feat-b');

    await setSort('created-asc');
    let html = await (await app.request('/')).text();
    expect(html.indexOf(`data-wt="${a}"`)).toBeLessThan(html.indexOf(`data-wt="${b}"`));

    await setSort('created-desc');
    html = await (await app.request('/')).text();
    expect(html.indexOf(`data-wt="${a}"`)).toBeGreaterThan(html.indexOf(`data-wt="${b}"`));
  });
});

describe('abrir en VS Code', () => {
  test('POST /wt/:id/open-editor abre el worktree en el editor (por comando)', async () => {
    const list = (await (await app.request('/api/worktrees.json')).json()) as {
      worktrees: Array<{ id: string; branch: string | null; path: string }>;
    };
    const featA = list.worktrees.find((w) => w.branch === 'feat-a')!;
    editorOpened.length = 0;
    const res = await app.request(`/wt/${featA.id}/open-editor`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(editorOpened).toEqual([featA.path]);
  });

  test('POST /wt/desconocido/open-editor responde 404', async () => {
    const res = await app.request('/wt/no-existe/open-editor', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  test('si el editor falla responde 500 con el error', async () => {
    const failApp = createHubApp({
      repoRoot: fx.repo,
      difit: fakeDifit,
      run: fakeRun,
      openEditor: async () => {
        throw new Error('no se encontró "code" en el PATH');
      },
    });
    const id = await idOf('feat-a');
    const res = await failApp.request(`/wt/${id}/open-editor`, { method: 'POST' });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain('PATH');
  });

  test('cada tarjeta tiene un botón VS Code (data-action=editor), sin deep link', async () => {
    const html = await (await app.request('/')).text();
    expect(html.match(/data-action="editor"/g)?.length).toBeGreaterThanOrEqual(5);
    expect(html).toContain('VS Code');
    expect(html).not.toContain('vscode://');
  });
});
