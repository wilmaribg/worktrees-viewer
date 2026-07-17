import { describe, expect, test } from 'vitest';
import { extractPrUrl } from './pr.js';

describe('extractPrUrl', () => {
  test('saca la URL del stdout de gh pr create', () => {
    const out = 'Creating pull request for feat-x into develop in acme/repo\n\nhttps://github.com/acme/repo/pull/123\n';
    expect(extractPrUrl(out)).toBe('https://github.com/acme/repo/pull/123');
  });

  test('saca la URL del error "already exists"', () => {
    const err =
      'a pull request for branch "feat-x" into branch "develop" already exists:\nhttps://github.com/acme/repo/pull/99';
    expect(extractPrUrl(err)).toBe('https://github.com/acme/repo/pull/99');
  });

  test('devuelve null si no hay URL de PR', () => {
    expect(extractPrUrl('error: could not push')).toBeNull();
    expect(extractPrUrl('https://github.com/acme/repo')).toBeNull();
  });
});
