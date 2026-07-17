import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Runner inyectable (para tests); ejecuta el comando del editor con sus argumentos. */
export type EditorRunner = (command: string, args: string[]) => Promise<void>;

const defaultRunner: EditorRunner = async (command, args) => {
  await execFileAsync(command, args, { timeout: 10_000 });
};

/** Comando del editor: WTV_EDITOR si está definido, si no `code` (VS Code). */
export function editorCommand(): string {
  return process.env['WTV_EDITOR']?.trim() || 'code';
}

/**
 * Abre la carpeta del worktree en el editor vía su CLI (`code <ruta>`).
 * A diferencia del deep link `vscode://file/<ruta>` —que abre la carpeta en la
 * ventana activa y "cierra" las demás—, el CLI la abre en su propia ventana sin
 * tocar las otras. Best-effort: si el comando no está en el PATH, error claro.
 */
export async function openInEditor(worktreePath: string, run: EditorRunner = defaultRunner): Promise<void> {
  const command = editorCommand();
  try {
    await run(command, [worktreePath]);
  } catch (err) {
    if ((err as { code?: string })?.code === 'ENOENT') {
      throw new Error(
        `no se encontró el comando "${command}" en el PATH; instalá el CLI de VS Code ` +
          `(paleta de comandos → "Shell Command: Install 'code' command in PATH") o definí WTV_EDITOR`,
      );
    }
    throw err;
  }
}
