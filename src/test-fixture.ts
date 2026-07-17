import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Fixture de tests: repo temporal con main y varios worktrees. */
export interface Fixture {
  root: string;
  repo: string;
  wtA: string; // cambios committeados (y behind respecto a main)
  wtB: string; // committeado + sin commitear + untracked
  wtClean: string; // sin cambios respecto a main
  wtDetached: string; // detached HEAD con un commit
  cleanup: () => void;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function write(dir: string, file: string, content: string): void {
  fs.writeFileSync(path.join(dir, file), content);
}

export function createFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wtv-fixture-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);

  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@test.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');

  write(repo, 'lib.js', 'function greet(name) {\n  return "Hello " + name;\n}\n');
  write(repo, 'README.md', '# Demo\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'initial');

  // wt-a: un commit propio
  const wtA = path.join(root, 'wt-a');
  git(repo, 'worktree', 'add', '-b', 'feat-a', wtA, 'main');
  write(wtA, 'lib.js', 'function greet(name) {\n  return `Hola ${name}!`;\n}\n');
  git(wtA, 'add', '-A');
  git(wtA, 'commit', '-m', 'feat: saludo en espanol');

  // wt-b: commit + cambio sin commitear + untracked
  const wtB = path.join(root, 'wt-b');
  git(repo, 'worktree', 'add', '-b', 'feat-b', wtB, 'main');
  write(wtB, 'README.md', '# Demo\n\nDocs mejoradas.\n');
  git(wtB, 'add', '-A');
  git(wtB, 'commit', '-m', 'docs: mejorar readme');
  write(wtB, 'README.md', '# Demo\n\nDocs mejoradas.\n\nWIP sin commitear.\n');
  write(wtB, 'nuevo.js', 'console.log("nuevo");\n');

  // wt-clean: rama sin cambios
  const wtClean = path.join(root, 'wt-clean');
  git(repo, 'worktree', 'add', '-b', 'feat-clean', wtClean, 'main');

  // wt-detached: detached HEAD con un commit propio
  const wtDetached = path.join(root, 'wt-detached');
  git(repo, 'worktree', 'add', '--detach', wtDetached, 'main');
  write(wtDetached, 'detached.txt', 'cambio detached\n');
  git(wtDetached, 'add', '-A');
  git(wtDetached, 'commit', '-m', 'wip detached');

  // main avanza: todos los worktrees quedan behind=1
  write(repo, 'CHANGELOG.md', '# Changelog\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'chore: changelog');

  return {
    root,
    repo,
    wtA,
    wtB,
    wtClean,
    wtDetached,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
