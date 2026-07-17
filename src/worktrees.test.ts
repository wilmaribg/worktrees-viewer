import { describe, expect, test } from 'vitest';
import { parseWorktreeList } from './worktrees.js';

const SAMPLE = `worktree /Users/me/repo
HEAD 608e8f793505d00128f0060cbf58cf879b9b60ea
branch refs/heads/main

worktree /Users/me/wt/wt-a
HEAD b5e63a59098eff64f84178c61d5a984d6011b413
branch refs/heads/feat-a

worktree /Users/me/wt/wt-detached
HEAD ac25a62727ecdb65a982a2994b92afd51844206b
detached

worktree /Users/me/wt/wt-locked
HEAD ac25a62727ecdb65a982a2994b92afd51844206b
branch refs/heads/feat-locked
locked porque si
`;

const SAMPLE_BARE = `worktree /Users/me/repo.git
bare

worktree /Users/me/wt/wt-a
HEAD b5e63a59098eff64f84178c61d5a984d6011b413
branch refs/heads/feat-a
`;

describe('parseWorktreeList', () => {
  test('parsea worktree principal y secundarios con rama', () => {
    const wts = parseWorktreeList(SAMPLE);
    expect(wts).toHaveLength(4);
    expect(wts[0]).toMatchObject({
      path: '/Users/me/repo',
      head: '608e8f793505d00128f0060cbf58cf879b9b60ea',
      branch: 'main',
      detached: false,
      bare: false,
      isMain: true,
    });
    expect(wts[1]).toMatchObject({
      path: '/Users/me/wt/wt-a',
      branch: 'feat-a',
      isMain: false,
    });
  });

  test('marca detached HEAD sin rama', () => {
    const wts = parseWorktreeList(SAMPLE);
    expect(wts[2]).toMatchObject({ branch: null, detached: true });
  });

  test('parsea worktrees locked', () => {
    const wts = parseWorktreeList(SAMPLE);
    expect(wts[3]).toMatchObject({ branch: 'feat-locked', locked: true });
    expect(wts[0]?.locked).toBe(false);
  });

  test('marca el worktree bare y no lo trata como rama', () => {
    const wts = parseWorktreeList(SAMPLE_BARE);
    expect(wts[0]).toMatchObject({ path: '/Users/me/repo.git', bare: true, isMain: true });
    expect(wts[1]).toMatchObject({ branch: 'feat-a', bare: false });
  });

  test('genera ids estables y únicos a partir del basename', () => {
    const wts = parseWorktreeList(SAMPLE);
    expect(wts.map((w) => w.id)).toEqual(['repo', 'wt-a', 'wt-detached', 'wt-locked']);
  });

  test('desambigua ids cuando dos worktrees comparten basename', () => {
    const dup = `worktree /a/feature
HEAD ${'0'.repeat(40)}
branch refs/heads/f1

worktree /b/feature
HEAD ${'1'.repeat(40)}
branch refs/heads/f2
`;
    const wts = parseWorktreeList(dup);
    expect(wts.map((w) => w.id)).toEqual(['feature', 'feature-2']);
  });

  test('devuelve [] para entrada vacía', () => {
    expect(parseWorktreeList('')).toEqual([]);
  });
});
