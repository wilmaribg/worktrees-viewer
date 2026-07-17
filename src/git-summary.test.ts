import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { detectBaseBranch, summarizeWorktree } from './git-summary.js';
import { createFixture, type Fixture } from './test-fixture.js';
import { listWorktrees, type Worktree } from './worktrees.js';

let fx: Fixture;
let byPath: Map<string, Worktree>;

beforeAll(async () => {
  fx = createFixture();
  const wts = await listWorktrees(fx.repo);
  byPath = new Map(wts.map((w) => [w.path, w]));
});

afterAll(() => fx.cleanup());

function wt(p: string): Worktree {
  const found = byPath.get(p) ?? byPath.get(`/private${p}`); // macOS: /tmp -> /private/tmp
  if (!found) throw new Error(`worktree no encontrado: ${p}`);
  return found;
}

describe('detectBaseBranch', () => {
  test('detecta main como rama base local', async () => {
    expect(await detectBaseBranch(fx.repo)).toBe('main');
  });

  test('el override gana', async () => {
    expect(await detectBaseBranch(fx.repo, 'develop')).toBe('develop');
  });
});

describe('summarizeWorktree', () => {
  test('wt-a: solo cambios committeados', async () => {
    const s = await summarizeWorktree(wt(fx.wtA), {});
    expect(s.baseBranch).toBe('main');
    expect(s.mergeBase).toMatch(/^[0-9a-f]{40}$/);
    expect(s.files.map((f) => f.path)).toEqual(['lib.js']);
    expect(s.files[0]?.status).toBe('modified');
    expect(s.ahead).toBe(1);
    expect(s.behind).toBe(1); // main avanzó tras crear el worktree
    expect(s.dirty).toBe(false);
    expect(s.diff).toContain('Hola');
    expect(s.truncated).toBe(false);
    expect(s.additions).toBeGreaterThan(0);
  });

  test('wt-b: incluye cambios sin commitear y untracked', async () => {
    const s = await summarizeWorktree(wt(fx.wtB), {});
    const paths = s.files.map((f) => f.path).sort();
    expect(paths).toEqual(['README.md', 'nuevo.js']);
    expect(s.files.find((f) => f.path === 'nuevo.js')?.status).toBe('untracked');
    expect(s.dirty).toBe(true);
    expect(s.diff).toContain('WIP sin commitear');
    expect(s.diff).toContain('nuevo.js');
  });

  test('wt-clean: sin cambios', async () => {
    const s = await summarizeWorktree(wt(fx.wtClean), {});
    expect(s.files).toEqual([]);
    expect(s.ahead).toBe(0);
    expect(s.dirty).toBe(false);
    expect(s.diff).toBe('');
  });

  test('detached HEAD funciona', async () => {
    const s = await summarizeWorktree(wt(fx.wtDetached), {});
    expect(s.ahead).toBe(1);
    expect(s.files.map((f) => f.path)).toEqual(['detached.txt']);
  });

  test('rama base inexistente: resumen vacío con baseBranch null', async () => {
    const s = await summarizeWorktree(wt(fx.wtA), { base: 'no-existe' });
    expect(s.baseBranch).toBeNull();
    expect(s.mergeBase).toBeNull();
    expect(s.files).toEqual([]);
    expect(s.diff).toBe('');
  });

  test('trunca diffs grandes y lo marca', async () => {
    const s = await summarizeWorktree(wt(fx.wtB), { maxDiffBytes: 50 });
    expect(s.truncated).toBe(true);
    expect(Buffer.byteLength(s.diff, 'utf8')).toBeLessThanOrEqual(50);
  });
});
