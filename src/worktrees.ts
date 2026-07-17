import path from 'node:path';
import { runGit } from './git.js';

export interface Worktree {
  /** Id estable y único, derivado del basename de la ruta (URL-safe). */
  id: string;
  /** Ruta absoluta del worktree. */
  path: string;
  /** SHA de HEAD ('' para worktrees bare). */
  head: string;
  /** Nombre corto de la rama, o null si detached/bare. */
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  /** true para el primer worktree listado (el principal del repo). */
  isMain: boolean;
}

/** Parsea la salida de `git worktree list --porcelain`. */
export function parseWorktreeList(porcelain: string): Worktree[] {
  const worktrees: Worktree[] = [];
  const usedIds = new Set<string>();

  for (const block of porcelain.split('\n\n')) {
    const lines = block.split('\n').filter((l) => l.length > 0);
    if (lines.length === 0) continue;

    let wtPath = '';
    let head = '';
    let branch: string | null = null;
    let detached = false;
    let bare = false;
    let locked = false;

    for (const line of lines) {
      if (line.startsWith('worktree ')) wtPath = line.slice('worktree '.length);
      else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length);
      else if (line.startsWith('branch ')) branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
      else if (line === 'detached') detached = true;
      else if (line === 'bare') bare = true;
      else if (line === 'locked' || line.startsWith('locked ')) locked = true;
    }

    if (!wtPath) continue;

    const base = sanitizeId(path.basename(wtPath));
    let id = base;
    for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
    usedIds.add(id);

    worktrees.push({
      id,
      path: wtPath,
      head,
      branch,
      detached,
      bare,
      locked,
      isMain: worktrees.length === 0,
    });
  }

  return worktrees;
}

function sanitizeId(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '-') || 'wt';
}

/** Enumera los worktrees del repo que contiene a `cwd`. */
export async function listWorktrees(cwd: string): Promise<Worktree[]> {
  const out = await runGit(['worktree', 'list', '--porcelain'], cwd);
  return parseWorktreeList(out);
}
