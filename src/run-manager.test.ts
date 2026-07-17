import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { RunManager } from './run-manager.js';
import type { Worktree } from './worktrees.js';

let tmpDir: string;
let manager: RunManager;

function fakeWt(id: string): Worktree {
  return { id, path: tmpDir, head: 'abc', branch: id, detached: false, bare: false, locked: false, isMain: false };
}

async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor: timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Comando que imprime su pid y una URL (con códigos ANSI) y se queda vivo. */
const SERVER_CMD = `node -e "console.log('PID='+process.pid); console.log('\\x1b[32mApp corriendo en\\x1b[0m http://localhost:34567/app'); setInterval(function(){},1000)"`;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtv-run-'));
  manager = new RunManager();
});

afterAll(async () => {
  await manager.stopAll();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('RunManager', () => {
  test('status de un worktree sin proceso es null', () => {
    expect(manager.status('nunca-corrido')).toBeNull();
  });

  test('start lanza el comando, captura logs y detecta la URL (ignorando ANSI)', async () => {
    manager.start(fakeWt('wt-serve'), SERVER_CMD);
    await waitFor(() => manager.status('wt-serve')?.url !== null);
    const s = manager.status('wt-serve')!;
    expect(s.running).toBe(true);
    expect(s.pid).toBeGreaterThan(0);
    expect(s.url).toBe('http://localhost:34567/app');
    expect(s.logs).toContain('App corriendo en');
    expect(s.command).toBe(SERVER_CMD);
  });

  test('start es idempotente mientras el proceso vive', () => {
    const before = manager.status('wt-serve')!;
    manager.start(fakeWt('wt-serve'), SERVER_CMD);
    expect(manager.status('wt-serve')!.pid).toBe(before.pid);
  });

  test('stop mata el proceso (incluido el hijo real del shell)', async () => {
    const s = manager.status('wt-serve')!;
    const nodePid = Number(/PID=(\d+)/.exec(s.logs)![1]);
    await manager.stop('wt-serve');
    const after = manager.status('wt-serve')!;
    expect(after.running).toBe(false);
    // el node interno también debe estar muerto
    await waitFor(() => {
      try {
        process.kill(nodePid, 0);
        return false;
      } catch {
        return true;
      }
    });
  });

  test('un comando que termina registra running=false y su exitCode', async () => {
    manager.start(fakeWt('wt-exit'), 'node -e "console.log(\'chao\'); process.exit(3)"');
    await waitFor(() => manager.status('wt-exit')?.running === false);
    const s = manager.status('wt-exit')!;
    expect(s.exitCode).toBe(3);
    expect(s.logs).toContain('chao');
    expect(s.url).toBeNull();
  });

  test('tras terminar, start vuelve a lanzar el comando', async () => {
    manager.start(fakeWt('wt-exit'), 'node -e "console.log(\'otra vez\'); process.exit(0)"');
    await waitFor(() => manager.status('wt-exit')?.running === false && manager.status('wt-exit')!.exitCode === 0);
    expect(manager.status('wt-exit')!.logs).toContain('otra vez');
  });

  test('los logs se truncan a un tope y conservan lo más reciente', async () => {
    const mgr = new RunManager({ maxLogBytes: 200 });
    mgr.start(
      fakeWt('wt-logs'),
      `node -e "for (let i = 0; i < 100; i++) console.log('linea-' + i)"`,
    );
    await waitFor(() => mgr.status('wt-logs')?.running === false);
    const s = mgr.status('wt-logs')!;
    expect(Buffer.byteLength(s.logs, 'utf8')).toBeLessThanOrEqual(200);
    expect(s.logs).toContain('linea-99');
    expect(s.logs).not.toContain('linea-0\n');
    await mgr.stopAll();
  });
});
