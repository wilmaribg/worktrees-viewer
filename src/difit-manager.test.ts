import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { DifitManager } from './difit-manager.js';
import { createFixture, type Fixture } from './test-fixture.js';
import { listWorktrees, type Worktree } from './worktrees.js';

let fx: Fixture;
let wtA: Worktree;
let wtB: Worktree;
let manager: DifitManager;

beforeAll(async () => {
  fx = createFixture();
  const wts = await listWorktrees(fx.repo);
  wtA = wts.find((w) => w.branch === 'feat-a')!;
  wtB = wts.find((w) => w.branch === 'feat-b')!;
  manager = new DifitManager({ basePort: 14966 });
});

afterAll(async () => {
  await manager.stopAll();
  fx.cleanup();
});

describe('DifitManager', () => {
  test('ensure() lanza difit para un worktree y responde HTTP', { timeout: 30_000 }, async () => {
    const inst = await manager.ensure(wtA, 'main');
    expect(inst.url).toMatch(/^http:\/\/localhost:\d+$/);
    expect(inst.pid).toBeGreaterThan(0);

    const res = await fetch(inst.url);
    expect(res.status).toBe(200);
  });

  test(
    'ensure() funciona en un worktree con archivos untracked (difit loguea antes de la URL)',
    { timeout: 30_000 },
    async () => {
      const inst = await manager.ensure(wtB, 'main');
      const res = await fetch(inst.url);
      expect(res.status).toBe(200);
    },
  );

  test('ensure() reutiliza la instancia viva', { timeout: 30_000 }, async () => {
    const first = await manager.ensure(wtA, 'main');
    const second = await manager.ensure(wtA, 'main');
    expect(second.port).toBe(first.port);
    expect(second.pid).toBe(first.pid);
  });

  test('stopAll() mata las instancias', { timeout: 30_000 }, async () => {
    const inst = await manager.ensure(wtA, 'main');
    await manager.stopAll();
    // el proceso ya no existe (kill 0 lanza ESRCH)
    await expect
      .poll(
        () => {
          try {
            process.kill(inst.pid, 0);
            return 'vivo';
          } catch {
            return 'muerto';
          }
        },
        { timeout: 5_000 },
      )
      .toBe('muerto');
  });
});
