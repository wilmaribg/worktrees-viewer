import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createFixture, type Fixture } from './test-fixture.js';

const CLI = path.join(import.meta.dirname, 'cli.ts');
const TSX = path.join(import.meta.dirname, '..', 'node_modules', '.bin', 'tsx');
const HUB_PORT = 15140;

let fx: Fixture;
let child: ChildProcess;
let stdout = '';

function waitForUrl(): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`hub no arrancó. stdout: ${stdout}`)), 20_000);
    child.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      const m = stdout.match(/http:\/\/[\w.]+:\d+/);
      if (m) {
        clearTimeout(timer);
        resolve(m[0]);
      }
    });
  });
}

beforeAll(() => {
  fx = createFixture();
  child = spawn(TSX, [CLI, '--no-open', '--port', String(HUB_PORT)], {
    cwd: fx.wtB, // arrancamos desde un worktree secundario: debe encontrar el repo igual
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr!.on('data', (c: Buffer) => (stdout += c.toString()));
});

afterAll(() => {
  child.kill('SIGINT');
  fx.cleanup();
});

describe('wtv CLI end-to-end', { timeout: 60_000 }, () => {
  let hubUrl: string;
  let difitUrl: string;
  let difitPid: number;

  test('arranca y anuncia la URL del hub', async () => {
    hubUrl = await waitForUrl();
    expect(hubUrl).toContain(String(HUB_PORT));
  });

  test('el dashboard y los endpoints agregados responden', async () => {
    const dash = await fetch(hubUrl);
    expect(dash.status).toBe(200);
    expect(await dash.text()).toContain('feat-b');

    const review = (await (await fetch(`${hubUrl}/api/review.json`)).json()) as {
      worktrees: Array<{ branch: string | null; diff: string }>;
    };
    const featB = review.worktrees.find((w) => w.branch === 'feat-b')!;
    expect(featB.diff).toContain('WIP sin commitear');

    const md = await (await fetch(`${hubUrl}/review.md`)).text();
    expect(md).toContain('# Revisión de worktrees');
  });

  test('/wt/:id/open lanza un difit real y redirige a él', async () => {
    const list = (await (await fetch(`${hubUrl}/api/worktrees.json`)).json()) as {
      worktrees: Array<{ id: string; branch: string | null }>;
    };
    const featB = list.worktrees.find((w) => w.branch === 'feat-b')!;

    const res = await fetch(`${hubUrl}/wt/${featB.id}/open`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    difitUrl = res.headers.get('location')!;
    expect(difitUrl).toMatch(/^http:\/\/localhost:\d+$/);

    const difitPage = await fetch(difitUrl);
    expect(difitPage.status).toBe(200);

    // el difitUrl ahora aparece en el agregado
    const again = (await (await fetch(`${hubUrl}/api/worktrees.json`)).json()) as {
      worktrees: Array<{ id: string; difitUrl: string | null }>;
    };
    expect(again.worktrees.find((w) => w.id === featB.id)?.difitUrl).toBe(difitUrl);
  });

  test('al cerrar el hub (SIGINT) mueren los difit hijos', async () => {
    // pid del difit hijo: lo sacamos comprobando qué proceso escucha el puerto
    const difitPort = Number(new URL(difitUrl).port);
    difitPid = await pidListeningOn(difitPort);
    expect(difitPid).toBeGreaterThan(0);

    child.kill('SIGINT');
    await expect
      .poll(
        () => {
          try {
            process.kill(difitPid, 0);
            return 'vivo';
          } catch {
            return 'muerto';
          }
        },
        { timeout: 10_000 },
      )
      .toBe('muerto');
  });
});

async function pidListeningOn(port: number): Promise<number> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const out = await promisify(execFile)('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']);
  return Number(out.stdout.trim().split('\n')[0]);
}
