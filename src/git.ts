import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 64 * 1024 * 1024; // diffs grandes

/** Ejecuta git con `cwd` dado y devuelve stdout (sin trailing newline). */
export async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: MAX_BUFFER });
  return stdout.replace(/\n$/, '');
}

/** Como runGit pero devuelve null si git sale con error (p. ej. ref inexistente). */
export async function tryGit(args: string[], cwd: string): Promise<string | null> {
  try {
    return await runGit(args, cwd);
  } catch {
    return null;
  }
}

/**
 * Para comandos donde exit 1 significa "hay diferencias" y no error
 * (git diff --no-index). Devuelve stdout en exit 0 o 1; lanza en el resto.
 */
export async function runGitDiffExit1(args: string[], cwd: string): Promise<string> {
  try {
    return await runGit(args, cwd);
  } catch (err) {
    const e = err as { code?: number; stdout?: string };
    if (e.code === 1 && typeof e.stdout === 'string') return e.stdout.replace(/\n$/, '');
    throw err;
  }
}
