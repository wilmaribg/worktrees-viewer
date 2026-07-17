import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Config global del usuario: ~/.config/wtv/config.json (o $XDG_CONFIG_HOME/wtv/).
 * Forma: { repos: { "<ruta-repo>": { base: "develop" } } }
 */
interface WtvConfig {
  repos?: Record<string, { base?: string }>;
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
  const config = readConfig();
  config.repos = { ...config.repos, [repoRoot]: { ...config.repos?.[repoRoot], base } };
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`);
}
