import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  configPath,
  readRepoBase,
  readRepoMode,
  readRepoRunCommand,
  writeRepoBase,
  writeRepoMode,
  writeRepoRunCommand,
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

  test('config corrupta se trata como vacía', () => {
    fs.writeFileSync(configPath(), 'no es json');
    expect(readRepoBase('/repo/uno')).toBeNull();
    writeRepoBase('/repo/uno', 'develop');
    expect(readRepoBase('/repo/uno')).toBe('develop');
  });
});
