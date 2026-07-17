import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createFixture, type Fixture } from './test-fixture.js';
import { worktreeDates } from './worktree-dates.js';

let fx: Fixture;
beforeAll(() => {
  fx = createFixture();
});
afterAll(() => fx.cleanup());

describe('worktreeDates', () => {
  test('createdAt presente y lastCommitAt = fecha del último commit', async () => {
    const expected = execFileSync('git', ['-C', fx.wtA, 'log', '-1', '--format=%cI'], {
      encoding: 'utf8',
    }).trim();
    const { createdAt, lastCommitAt } = await worktreeDates(fx.wtA);
    expect(createdAt).not.toBeNull();
    expect(Number.isNaN(Date.parse(createdAt!))).toBe(false);
    expect(lastCommitAt).toBe(expected);
  });

  test('directorio sin git: createdAt presente, lastCommitAt null', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtv-nogit-'));
    try {
      const { createdAt, lastCommitAt } = await worktreeDates(dir);
      expect(createdAt).not.toBeNull();
      expect(lastCommitAt).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
