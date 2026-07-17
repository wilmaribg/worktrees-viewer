import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  configPath,
  isWorktreeArchived,
  readRepoArchived,
  readRepoBase,
  readRepoMode,
  readRepoRunCommand,
  readRepoSort,
  readRepoWorktreeRunCommand,
  writeRepoArchived,
  writeRepoBase,
  writeRepoMode,
  writeRepoRunCommand,
  writeRepoSort,
  writeRepoWorktreeRunCommand,
} from './config.js';

let tmpHome: string;
const prevXdg = process.env['XDG_CONFIG_HOME'];

beforeAll(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wtv-config-'));
  process.env['XDG_CONFIG_HOME'] = tmpHome;
});

afterAll(() => {
  if (prevXdg === undefined) delete process.env['XDG_CONFIG_HOME'];
  else process.env['XDG_CONFIG_HOME'] = prevXdg;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('config', () => {
  test('configPath respeta XDG_CONFIG_HOME', () => {
    expect(configPath()).toBe(path.join(tmpHome, 'wtv', 'config.json'));
  });

  test('readRepoBase devuelve null si no hay config', () => {
    expect(readRepoBase('/algun/repo')).toBeNull();
  });

  test('writeRepoBase + readRepoBase hacen round-trip por repo', () => {
    writeRepoBase('/repo/uno', 'develop');
    writeRepoBase('/repo/dos', 'master');
    expect(readRepoBase('/repo/uno')).toBe('develop');
    expect(readRepoBase('/repo/dos')).toBe('master');
    expect(readRepoBase('/repo/otro')).toBeNull();
  });

  test('writeRepoBase actualiza sin perder otros repos', () => {
    writeRepoBase('/repo/uno', 'main');
    expect(readRepoBase('/repo/uno')).toBe('main');
    expect(readRepoBase('/repo/dos')).toBe('master');
  });

  test('readRepoMode devuelve pr por defecto y hace round-trip', () => {
    expect(readRepoMode('/repo/uno')).toBe('pr');
    writeRepoMode('/repo/uno', 'wip');
    expect(readRepoMode('/repo/uno')).toBe('wip');
    // no pisa la base guardada del mismo repo
    expect(readRepoBase('/repo/uno')).toBe('main');
    writeRepoMode('/repo/uno', 'pr');
    expect(readRepoMode('/repo/uno')).toBe('pr');
  });

  test('readRepoRunCommand devuelve null por defecto y hace round-trip', () => {
    expect(readRepoRunCommand('/repo/uno')).toBeNull();
    writeRepoRunCommand('/repo/uno', 'cd projects/suite && npm run dev');
    expect(readRepoRunCommand('/repo/uno')).toBe('cd projects/suite && npm run dev');
    // no pisa base ni mode del mismo repo
    expect(readRepoBase('/repo/uno')).toBe('main');
    expect(readRepoMode('/repo/uno')).toBe('pr');
  });

  test('override de comando por worktree: round-trip y limpieza', () => {
    // sin override cae en null (el caller decide usar el general)
    expect(readRepoWorktreeRunCommand('/repo/uno', 'wt-api')).toBeNull();

    writeRepoWorktreeRunCommand('/repo/uno', 'wt-api', 'cd apps/api && npm start');
    writeRepoWorktreeRunCommand('/repo/uno', 'wt-web', 'cd apps/web && npm run dev');
    expect(readRepoWorktreeRunCommand('/repo/uno', 'wt-api')).toBe('cd apps/api && npm start');
    expect(readRepoWorktreeRunCommand('/repo/uno', 'wt-web')).toBe('cd apps/web && npm run dev');
    // no toca el comando general ni otros campos
    expect(readRepoRunCommand('/repo/uno')).toBe('cd projects/suite && npm run dev');
    expect(readRepoBase('/repo/uno')).toBe('main');

    // null borra el override (vuelve al general)
    writeRepoWorktreeRunCommand('/repo/uno', 'wt-api', null);
    expect(readRepoWorktreeRunCommand('/repo/uno', 'wt-api')).toBeNull();
    expect(readRepoWorktreeRunCommand('/repo/uno', 'wt-web')).toBe('cd apps/web && npm run dev');
  });

  test('readRepoSort devuelve modified-desc por defecto y hace round-trip', () => {
    expect(readRepoSort('/repo/uno')).toBe('modified-desc');
    writeRepoSort('/repo/uno', 'created-asc');
    expect(readRepoSort('/repo/uno')).toBe('created-asc');
    // no pisa base ni comando del mismo repo
    expect(readRepoBase('/repo/uno')).toBe('main');
    expect(readRepoRunCommand('/repo/uno')).toBe('cd projects/suite && npm run dev');
  });

  test('archivar/desarchivar worktrees: round-trip por id', () => {
    expect(readRepoArchived('/repo/uno')).toEqual([]);
    expect(isWorktreeArchived('/repo/uno', 'wt-api')).toBe(false);

    writeRepoArchived('/repo/uno', 'wt-api', true);
    writeRepoArchived('/repo/uno', 'wt-web', true);
    expect(isWorktreeArchived('/repo/uno', 'wt-api')).toBe(true);
    expect(readRepoArchived('/repo/uno').sort()).toEqual(['wt-api', 'wt-web']);

    // archivar dos veces el mismo id no lo duplica
    writeRepoArchived('/repo/uno', 'wt-api', true);
    expect(readRepoArchived('/repo/uno').sort()).toEqual(['wt-api', 'wt-web']);

    // desarchivar quita solo ese id
    writeRepoArchived('/repo/uno', 'wt-api', false);
    expect(isWorktreeArchived('/repo/uno', 'wt-api')).toBe(false);
    expect(readRepoArchived('/repo/uno')).toEqual(['wt-web']);

    // no toca el orden ni la base guardados
    expect(readRepoSort('/repo/uno')).toBe('created-asc');
    expect(readRepoBase('/repo/uno')).toBe('main');
  });

  test('config corrupta se trata como vacía', () => {
    fs.writeFileSync(configPath(), 'no es json');
    expect(readRepoBase('/repo/uno')).toBeNull();
    writeRepoBase('/repo/uno', 'develop');
    expect(readRepoBase('/repo/uno')).toBe('develop');
  });
});
