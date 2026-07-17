import fs from 'node:fs/promises';
import { tryGit } from './git.js';

export interface WorktreeDates {
  /** ISO de cuándo se creó el directorio del worktree (birthtime), o null. */
  createdAt: string | null;
  /** ISO del último commit en HEAD (`git log -1 %cI`), o null si no hay. */
  lastCommitAt: string | null;
}

/** Convierte epoch-ms (>0) a ISO, o null si no es un instante válido. */
function toIso(ms: number): string | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

/**
 * Fechas de un worktree para ordenar el dashboard:
 * - createdAt: birthtime del directorio (fallback ctime → mtime). En APFS es real.
 * - lastCommitAt: fecha del último commit; null si el worktree no tiene commits.
 */
export async function worktreeDates(worktreePath: string): Promise<WorktreeDates> {
  let createdAt: string | null = null;
  try {
    const st = await fs.stat(worktreePath);
    createdAt = toIso(st.birthtimeMs) ?? toIso(st.ctimeMs) ?? toIso(st.mtimeMs);
  } catch {
    createdAt = null;
  }

  const lastCommitAt = await tryGit(['log', '-1', '--format=%cI'], worktreePath);

  return { createdAt, lastCommitAt: lastCommitAt || null };
}
