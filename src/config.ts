import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Alcance del review: diff del PR completo o solo cambios sin commitear. */
export type ReviewMode = 'pr' | 'wip';

/**
 * Config global del usuario: ~/.config/wtv/config.json (o $XDG_CONFIG_HOME/wtv/).
 * Forma: { repos: { "<ruta-repo>": { base: "develop", mode: "pr" } } }
 */
interface RepoEntry {
  base?: string;
  mode?: ReviewMode;
  /** Comando shell general que levanta el proyecto (default para todos los worktrees). */
  runCommand?: string;
  /** Overrides por worktree (keyed por id): comando propio para monorepos. */
  worktreeRunCommands?: Record<string, string>;
}

interface WtvConfig {
  repos?: Record<string, RepoEntry>;
}

export function configPath(): string {
  const configHome = process.env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config');
  return path.join(configHome, 'wtv', 'config.json');
}

function readConfig(): WtvConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), 'utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as WtvConfig) : {};
  } catch {
    return {}; // no existe o corrupta
  }
}

/** Rama base guardada para el repo, o null si no hay. */
export function readRepoBase(repoRoot: string): string | null {
  return readConfig().repos?.[repoRoot]?.base ?? null;
}

/** Guarda la rama base para el repo (crea el directorio/archivo si no existen). */
export function writeRepoBase(repoRoot: string, base: string): void {
  writeRepoEntry(repoRoot, { base });
}

/** Modo de review guardado para el repo ('pr' si no hay nada). */
export function readRepoMode(repoRoot: string): ReviewMode {
  return readConfig().repos?.[repoRoot]?.mode ?? 'pr';
}

export function writeRepoMode(repoRoot: string, mode: ReviewMode): void {
  writeRepoEntry(repoRoot, { mode });
}

/** Comando de arranque guardado para el repo, o null si no hay. */
export function readRepoRunCommand(repoRoot: string): string | null {
  return readConfig().repos?.[repoRoot]?.runCommand ?? null;
}

export function writeRepoRunCommand(repoRoot: string, runCommand: string): void {
  writeRepoEntry(repoRoot, { runCommand });
}

/** Override de comando para un worktree concreto, o null si usa el general. */
export function readRepoWorktreeRunCommand(repoRoot: string, wtId: string): string | null {
  return readConfig().repos?.[repoRoot]?.worktreeRunCommands?.[wtId] ?? null;
}

/** Guarda (o borra, con command=null) el override de comando de un worktree. */
export function writeRepoWorktreeRunCommand(repoRoot: string, wtId: string, command: string | null): void {
  const config = readConfig();
  const entry = config.repos?.[repoRoot] ?? {};
  const overrides = { ...entry.worktreeRunCommands };
  if (command === null) delete overrides[wtId];
  else overrides[wtId] = command;
  writeRepoEntry(repoRoot, { worktreeRunCommands: overrides });
}

function writeRepoEntry(repoRoot: string, entry: Partial<RepoEntry>): void {
  const config = readConfig();
  config.repos = { ...config.repos, [repoRoot]: { ...config.repos?.[repoRoot], ...entry } };
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`);
}
