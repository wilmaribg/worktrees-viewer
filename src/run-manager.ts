import { spawn, type ChildProcess } from 'node:child_process';
import type { Worktree } from './worktrees.js';

export interface RunStatus {
  running: boolean;
  pid: number | null;
  /** Primera URL http(s) detectada en la salida del comando, o null. */
  url: string | null;
  command: string;
  startedAt: string;
  exitCode: number | null;
  logs: string;
}

interface RunProc {
  child: ChildProcess;
  command: string;
  startedAt: string;
  logs: string;
  url: string | null;
  running: boolean;
  exitCode: number | null;
  exited: Promise<void>;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const URL_RE = /https?:\/\/[^\s"'\])]+/;

const DEFAULT_MAX_LOG_BYTES = 64 * 1024;

/**
 * Lanza y trackea el comando de arranque del proyecto por worktree.
 * El comando corre en un shell con su propio process group para poder
 * matar también a sus hijos (npm → node → dev server).
 */
export class RunManager {
  private procs = new Map<string, RunProc>();
  private maxLogBytes: number;

  constructor(opts: { maxLogBytes?: number } = {}) {
    this.maxLogBytes = opts.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
  }

  /** Lanza el comando en el worktree. Si ya hay uno corriendo, lo reutiliza. */
  start(wt: Worktree, command: string): RunStatus {
    const existing = this.procs.get(wt.id);
    if (existing?.running) return this.toStatus(existing);

    const child = spawn(command, {
      cwd: wt.path,
      shell: true,
      detached: true, // process group propio → stop mata a todo el árbol
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const proc: RunProc = {
      child,
      command,
      startedAt: new Date().toISOString(),
      logs: '',
      url: null,
      running: true,
      exitCode: null,
      exited: new Promise((resolve) => {
        child.on('exit', (code) => {
          proc.running = false;
          proc.exitCode = code;
          resolve();
        });
        child.on('error', () => {
          proc.running = false;
          resolve();
        });
      }),
    };

    const append = (chunk: Buffer): void => {
      proc.logs += chunk.toString('utf8');
      if (proc.logs.length > this.maxLogBytes) {
        proc.logs = proc.logs.slice(proc.logs.length - this.maxLogBytes);
      }
      if (!proc.url) {
        const match = URL_RE.exec(proc.logs.replace(ANSI_RE, ''));
        if (match) proc.url = match[0];
      }
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    this.procs.set(wt.id, proc);
    return this.toStatus(proc);
  }

  status(wtId: string): RunStatus | null {
    const proc = this.procs.get(wtId);
    return proc ? this.toStatus(proc) : null;
  }

  /** SIGTERM al process group; SIGKILL si no muere en unos segundos. */
  async stop(wtId: string): Promise<void> {
    const proc = this.procs.get(wtId);
    if (!proc?.running || !proc.child.pid) return;
    killGroup(proc.child.pid, 'SIGTERM');
    const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 3000));
    if ((await Promise.race([proc.exited, timeout])) === 'timeout') {
      killGroup(proc.child.pid, 'SIGKILL');
      await proc.exited;
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.procs.keys()].map((id) => this.stop(id)));
  }

  private toStatus(proc: RunProc): RunStatus {
    return {
      running: proc.running,
      pid: proc.child.pid ?? null,
      url: proc.url,
      command: proc.command,
      startedAt: proc.startedAt,
      exitCode: proc.exitCode,
      logs: proc.logs,
    };
  }
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal); // grupo completo
  } catch {
    try {
      process.kill(pid, signal); // fallback: solo el shell
    } catch {
      // ya murió
    }
  }
}
