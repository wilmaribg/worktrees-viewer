import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Alcance del review: diff del PR completo o solo cambios sin commitear. */
export type ReviewMode = 'pr' | 'wip';

/**
 * Config global del usuario: ~/.config/wtv/config.json (o $XDG_CONFIG_HOME/wtv/).
 * Forma: { repos: { "<ruta-repo>": { base: "develop", mode: "pr" } } }
 */
interface WtvConfig {
  repos?: Record<string, { base?: string; mode?: ReviewMode }>;
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

function writeRepoEntry(repoRoot: string, entry: { base?: string; mode?: ReviewMode }): void {
  const config = readConfig();
  config.repos = { ...config.repos, [repoRoot]: { ...config.repos?.[repoRoot], ...entry } };
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`);
}
