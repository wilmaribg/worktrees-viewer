import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { configPath, readRepoBase, writeRepoBase } from './config.js';

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

  test('config corrupta se trata como vacía', () => {
    fs.writeFileSync(configPath(), 'no es json');
    expect(readRepoBase('/repo/uno')).toBeNull();
    writeRepoBase('/repo/uno', 'develop');
    expect(readRepoBase('/repo/uno')).toBe('develop');
  });
});
