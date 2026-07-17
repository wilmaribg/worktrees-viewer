import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Worktree } from './worktrees.js';

export interface DifitInstance {
  url: string;
  port: number;
  /** pid del proceso difit (hijo directo nuestro). */
  pid: number;
}

export interface DifitManagerOptions {
  /** Primer puerto preferido para los hijos (difit hace fallback a +1 si está ocupado). */
  basePort?: number;
  /** Args extra que se pasan a difit tal cual. */
  extraArgs?: string[];
}

const DEFAULT_BASE_PORT = 4966;
const SPAWN_TIMEOUT_MS = 20_000;

/**
 * Lanza y trackea una instancia de difit por worktree (spawn perezoso).
 *
 * No usamos `difit --background`: su contrato JSON se rompe cuando el worktree
 * tiene archivos untracked (difit loguea "✅ Files added with --intent-to-add"
 * antes del JSON y el padre background solo reenvía la primera línea). En su
 * lugar corremos difit como hijo directo con --keep-alive y parseamos la URL
 * de su salida, escaneando todas las líneas.
 */
export class DifitManager {
  private readonly instances = new Map<string, DifitInstance>();
  private readonly basePort: number;
  private readonly extraArgs: string[];
  private nextPortOffset = 0;

  constructor(opts: DifitManagerOptions = {}) {
    this.basePort = opts.basePort ?? DEFAULT_BASE_PORT;
    this.extraArgs = opts.extraArgs ?? [];
  }

  /** Devuelve la instancia viva para el worktree, lanzando difit si hace falta. */
  async ensure(wt: Worktree, baseBranch: string | null): Promise<DifitInstance> {
    const existing = this.instances.get(wt.id);
    if (existing && isAlive(existing.pid)) return existing;
    this.instances.delete(wt.id);

    const port = this.basePort + this.nextPortOffset++;
    const args = [
      '.',
      ...(baseBranch ? [baseBranch, '--merge-base'] : []),
      '--include-untracked',
      '--keep-alive',
      '--no-open',
      '--port',
      String(port),
      ...this.extraArgs,
    ];

    const inst = await spawnDifit(args, wt.path);
    this.instances.set(wt.id, inst);
    return inst;
  }

  /** URL de la instancia viva, o null si no hay ninguna corriendo. */
  liveUrl(wtId: string): string | null {
    const inst = this.instances.get(wtId);
    return inst && isAlive(inst.pid) ? inst.url : null;
  }

  async stop(wtId: string): Promise<void> {
    const inst = this.instances.get(wtId);
    if (inst) {
      this.instances.delete(wtId);
      killQuiet(inst.pid);
    }
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.instances.keys()]) await this.stop(id);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killQuiet(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // ya muerto
  }
}

const URL_RE = /https?:\/\/[^\s]+:(\d+)/;

function spawnDifit(args: string[], cwd: string): Promise<DifitInstance> {
  const bin = resolveDifitBin();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill();
      reject(new Error(`difit no arrancó en ${SPAWN_TIMEOUT_MS}ms (stderr: ${stderr.slice(0, 500)})`));
    }, SPAWN_TIMEOUT_MS);

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      // difit anuncia "🚀 difit server started on http://localhost:PORT",
      // posiblemente precedido de líneas informativas (p. ej. untracked).
      const match = stdout.match(URL_RE);
      if (match && child.pid) {
        const url = match[0];
        child.unref();
        finish(() => resolve({ url, port: Number(match[1]), pid: child.pid! }));
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => finish(() => reject(err)));
    child.on('exit', (code) => {
      finish(() =>
        reject(new Error(`difit terminó antes de anunciar su URL (código ${code}): ${stderr.slice(0, 500)}`)),
      );
    });
  });
}

let cachedBin: string | null = null;

/** Resuelve la ruta al entrypoint del CLI de difit instalado como dependencia. */
function resolveDifitBin(): string {
  if (cachedBin) return cachedBin;
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve('difit/package.json');
  const pkg = require('difit/package.json') as { bin?: string | Record<string, string> };
  const rel = typeof pkg.bin === 'string' ? pkg.bin : (pkg.bin?.['difit'] ?? 'dist/cli.js');
  cachedBin = path.join(path.dirname(pkgPath), rel);
  return cachedBin;
}
