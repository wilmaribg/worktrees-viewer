import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readRepoBase } from './config.js';
import type { DifitInstance } from './difit-manager.js';
import { createHubApp, type HubApp } from './hub-server.js';
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
  async stopAll(): Promise<void> {
    stopAllCalls++;
  },
};

beforeAll(() => {
  tmpConfigHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wtv-hub-config-'));
  process.env['XDG_CONFIG_HOME'] = tmpConfigHome;
  fx = createFixture();
  app = createHubApp({ repoRoot: fx.repo, difit: fakeDifit });
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
    const flagApp = createHubApp({ repoRoot: fx.repo, base: 'main', difit: fakeDifit });
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
