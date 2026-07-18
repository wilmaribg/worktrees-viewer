import { describe, expect, test } from 'vitest';
import { extractPrUrl, lookupPullRequest } from './pr.js';

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

describe('lookupPullRequest', () => {
  test('parsea url, state y number del JSON de gh pr view', async () => {
    const gh = async () =>
      JSON.stringify({ url: 'https://github.com/acme/repo/pull/42', state: 'OPEN', number: 42 });
    expect(await lookupPullRequest('feat-x', '/tmp', gh)).toEqual({
      url: 'https://github.com/acme/repo/pull/42',
      state: 'OPEN',
      number: 42,
    });
  });

  test('null si gh falla (sin PR / sin gh / offline)', async () => {
    const gh = async () => {
      throw new Error('no pull requests found for branch "feat-x"');
    };
    expect(await lookupPullRequest('feat-x', '/tmp', gh)).toBeNull();
  });

  test('null si la salida no es JSON válido', async () => {
    const gh = async () => 'no soy json';
    expect(await lookupPullRequest('feat-x', '/tmp', gh)).toBeNull();
  });
});
