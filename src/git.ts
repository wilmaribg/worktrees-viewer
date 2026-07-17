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
