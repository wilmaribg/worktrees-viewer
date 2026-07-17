import open from 'open';

/** Abre la URL en el navegador por defecto; los fallos no son fatales. */
export async function openBrowser(url: string): Promise<void> {
  try {
    await open(url);
  } catch (err) {
    console.error(`No se pudo abrir el navegador: ${(err as Error).message}`);
  }
}
