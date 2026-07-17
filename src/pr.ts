import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Worktree } from './worktrees.js';

const execFileAsync = promisify(execFile);

export interface PrResult {
  url: string;
  /** false si el PR ya existía y solo devolvimos su URL. */
  created: boolean;
}

const PR_URL_RE = /https:\/\/github\.com\/[^\s"']+\/pull\/\d+/;

/** Primera URL de PR de GitHub en el texto, o null. */
export function extractPrUrl(text: string): string | null {
  return PR_URL_RE.exec(text)?.[0] ?? null;
}

/**
 * Pushea la rama del worktree y crea el PR con gh CLI (--fill: título/cuerpo
 * desde los commits). Si el PR ya existe, devuelve su URL con created=false.
 */
export async function createPullRequest(wt: Worktree, base: string | null): Promise<PrResult> {
  if (!wt.branch) throw new Error('worktree en detached HEAD: no hay rama que pushear');

  await run('git', ['push', '-u', 'origin', wt.branch], wt.path);

  const args = ['pr', 'create', '--fill', '--head', wt.branch, ...(base ? ['--base', base] : [])];
  try {
    const out = await run('gh', args, wt.path);
    const url = extractPrUrl(out);
    if (!url) throw new Error(`gh pr create no devolvió URL: ${out.trim()}`);
    return { url, created: true };
  } catch (err) {
    // "a pull request for branch X ... already exists: <url>"
    const url = extractPrUrl(errorText(err));
    if (url) return { url, created: false };
    throw err;
  }
}

async function run(cmd: string, args: string[], cwd: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { cwd, maxBuffer: 8 * 1024 * 1024 });
    return `${stdout}\n${stderr}`;
  } catch (err) {
    throw new Error(`${cmd} ${args.join(' ')} falló: ${errorText(err)}`, { cause: err });
  }
}

function errorText(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    return [e.stderr, e.stdout, e.message].filter(Boolean).join('\n');
  }
  return String(err);
}
