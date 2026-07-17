import path from 'node:path';
import { runGit, runGitDiffExit1, tryGit } from './git.js';
import type { Worktree } from './worktrees.js';

export type FileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'other';

export interface FileChange {
  path: string;
  status: FileStatus;
  additions: number;
  deletions: number;
}

export interface WorktreeSummary {
  /** Rama base efectiva, o null si no se pudo resolver. */
  baseBranch: string | null;
  /** SHA del merge-base entre la base y HEAD, o null. */
  mergeBase: string | null;
  files: FileChange[];
  additions: number;
  deletions: number;
  /** Commits de HEAD que no están en la base. */
  ahead: number;
  /** Commits de la base que no están en HEAD. */
  behind: number;
  /** true si hay cambios sin commitear (staged, unstaged o untracked). */
  dirty: boolean;
  /** Diff unificado crudo: merge-base → working tree, más untracked. */
  diff: string;
  truncated: boolean;
}

export interface SummaryOptions {
  /** Rama base explícita (override de la auto-detección). */
  base?: string;
  /** Tope de bytes para `diff` (default 2 MB). */
  maxDiffBytes?: number;
  /**
   * 'pr' (default): diff del merge-base con la base → working tree.
   * 'wip': solo cambios sin commitear (HEAD → working tree) + untracked.
   */
  mode?: 'pr' | 'wip';
}

const DEFAULT_MAX_DIFF_BYTES = 2 * 1024 * 1024;

/**
 * Resuelve la rama base: override → origin/HEAD → main → master.
 * Devuelve null si no encuentra ninguna.
 */
export async function detectBaseBranch(cwd: string, override?: string): Promise<string | null> {
  if (override) return override;
  const originHead = await tryGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd);
  if (originHead) return originHead; // p. ej. "origin/main"
  for (const candidate of ['main', 'master']) {
    if ((await tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`], cwd)) !== null) {
      return candidate;
    }
  }
  return null;
}

const EMPTY_SUMMARY: Omit<WorktreeSummary, 'baseBranch' | 'mergeBase'> = {
  files: [],
  additions: 0,
  deletions: 0,
  ahead: 0,
  behind: 0,
  dirty: false,
  diff: '',
  truncated: false,
};

/** Calcula el resumen de cambios de un worktree contra su rama base. */
export async function summarizeWorktree(wt: Worktree, opts: SummaryOptions): Promise<WorktreeSummary> {
  const cwd = wt.path;
  const maxDiffBytes = opts.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES;
  const mode = opts.mode ?? 'pr';

  const baseBranch = await detectBaseBranch(cwd, opts.base);
  const mergeBase = baseBranch ? await tryGit(['merge-base', baseBranch, 'HEAD'], cwd) : null;
  const status = await runGit(['status', '--porcelain'], cwd);
  const dirty = status.length > 0;

  // Referencia contra la que se calculan archivos y diff:
  // pr → merge-base con la base; wip → HEAD (solo lo sin commitear).
  const diffRef = mode === 'wip' ? 'HEAD' : mergeBase;
  if (!diffRef || (mode === 'pr' && !baseBranch)) {
    return { ...EMPTY_SUMMARY, baseBranch: mergeBase ? baseBranch : null, mergeBase, dirty };
  }

  const [counts, nameStatus, untrackedOut, diffTracked] = await Promise.all([
    baseBranch ? runGit(['rev-list', '--left-right', '--count', `${baseBranch}...HEAD`], cwd) : Promise.resolve(''),
    runGit(['diff', '--name-status', '-M', diffRef], cwd),
    runGit(['ls-files', '--others', '--exclude-standard'], cwd),
    runGit(['diff', '-M', diffRef], cwd),
  ]);
  const numstat = await runGit(['diff', '--numstat', '-M', diffRef], cwd);

  const [behindStr, aheadStr] = counts.split('\t');
  const behind = Number(behindStr) || 0;
  const ahead = Number(aheadStr) || 0;

  const files = parseTrackedFiles(nameStatus, numstat);

  // Untracked: diff sintético por archivo con --no-index
  const untracked = untrackedOut.length > 0 ? untrackedOut.split('\n') : [];
  const untrackedDiffs: string[] = [];
  for (const file of untracked) {
    const d = await runGitDiffExit1(['diff', '--no-index', '--', '/dev/null', path.join(cwd, file)], cwd);
    // Reescribe las rutas absolutas del --no-index a rutas relativas del repo
    const rel = d.replaceAll(path.join(cwd, file), file);
    untrackedDiffs.push(rel);
    const nums = await runGitDiffExit1(
      ['diff', '--no-index', '--numstat', '--', '/dev/null', path.join(cwd, file)],
      cwd,
    );
    const additions = Number(nums.split('\t')[0]) || 0;
    files.push({ path: file, status: 'untracked', additions, deletions: 0 });
  }

  let diff = [diffTracked, ...untrackedDiffs].filter((d) => d.length > 0).join('\n');
  let truncated = false;
  if (Buffer.byteLength(diff, 'utf8') > maxDiffBytes) {
    diff = truncateUtf8(diff, maxDiffBytes);
    truncated = true;
  }

  return {
    baseBranch,
    mergeBase,
    files,
    additions: files.reduce((sum, f) => sum + f.additions, 0),
    deletions: files.reduce((sum, f) => sum + f.deletions, 0),
    ahead,
    behind,
    dirty,
    diff,
    truncated,
  };
}

const STATUS_MAP: Record<string, FileStatus> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
};

function parseTrackedFiles(nameStatus: string, numstat: string): FileChange[] {
  // numstat: "adds\tdels\tpath" ("-" para binarios; renames: "old => new" o "{a => b}/c")
  const statLines = numstat.length > 0 ? numstat.split('\n') : [];
  // name-status: "M\tpath" | "R100\told\tnew" — mismo orden que numstat
  const nsLines = nameStatus.length > 0 ? nameStatus.split('\n') : [];

  return nsLines.map((line, i) => {
    const parts = line.split('\t');
    const code = parts[0] ?? '';
    const filePath = parts[parts.length - 1] ?? ''; // en renames, la ruta nueva
    const status = STATUS_MAP[code.charAt(0)] ?? 'other';
    const stat = statLines[i]?.split('\t') ?? [];
    return {
      path: filePath,
      status,
      additions: Number(stat[0]) || 0,
      deletions: Number(stat[1]) || 0,
    };
  });
}

/** Corta a maxBytes sin partir un code point UTF-8. */
function truncateUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}
