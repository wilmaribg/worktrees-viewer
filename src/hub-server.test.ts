import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { DifitInstance } from './difit-manager.js';
import { createHubApp, type HubApp } from './hub-server.js';
import { createFixture, type Fixture } from './test-fixture.js';
import type { Worktree } from './worktrees.js';

let fx: Fixture;
let app: HubApp;
const ensured: Array<{ wt: Worktree; base: string | null }> = [];

const fakeDifit = {
  async ensure(wt: Worktree, base: string | null): Promise<DifitInstance> {
    ensured.push({ wt, base });
    return { url: 'http://localhost:9999', port: 9999, pid: 12345 };
  },
  liveUrl(): string | null {
    return null;
  },
};

beforeAll(() => {
  fx = createFixture();
  app = createHubApp({ repoRoot: fx.repo, difit: fakeDifit });
});

afterAll(() => fx.cleanup());

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
