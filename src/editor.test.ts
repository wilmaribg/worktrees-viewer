import { afterEach, describe, expect, test } from 'vitest';
import { openInEditor } from './editor.js';

const prevEditor = process.env['WTV_EDITOR'];
afterEach(() => {
  if (prevEditor === undefined) delete process.env['WTV_EDITOR'];
  else process.env['WTV_EDITOR'] = prevEditor;
});

describe('openInEditor', () => {
  test('ejecuta "code <ruta>" por defecto', async () => {
    delete process.env['WTV_EDITOR'];
    const calls: Array<{ command: string; args: string[] }> = [];
    await openInEditor('/tmp/mi-worktree', async (command, args) => {
      calls.push({ command, args });
    });
    expect(calls).toEqual([{ command: 'code', args: ['/tmp/mi-worktree'] }]);
  });

  test('respeta WTV_EDITOR para otros editores (p. ej. cursor)', async () => {
    process.env['WTV_EDITOR'] = 'cursor';
    const commands: string[] = [];
    await openInEditor('/tmp/wt', async (command) => {
      commands.push(command);
    });
    expect(commands).toEqual(['cursor']);
  });

  test('si el comando no está en el PATH da un error claro', async () => {
    delete process.env['WTV_EDITOR'];
    await expect(
      openInEditor('/tmp/wt', async () => {
        const err = new Error('spawn code ENOENT') as Error & { code?: string };
        err.code = 'ENOENT';
        throw err;
      }),
    ).rejects.toThrow(/PATH/);
  });
});
