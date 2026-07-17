import { Command } from 'commander';
import { DifitManager } from './difit-manager.js';
import { tryGit } from './git.js';
import { startHub } from './hub-server.js';
import { openBrowser } from './open-browser.js';

const DEFAULT_HUB_PORT = 4900;

interface CliOptions {
  port: string;
  host: string;
  base?: string;
  open: boolean;
  difitArgs?: string;
}

async function main(): Promise<void> {
  const program = new Command()
    .name('wtv')
    .description('Panel local para revisar los diffs de todos tus git worktrees antes de crear un PR')
    .option('-p, --port <port>', 'puerto del hub', String(DEFAULT_HUB_PORT))
    .option('--host <host>', 'host donde escuchar', '127.0.0.1')
    .option('-b, --base <branch>', 'rama base para los diffs (default: auto-detectada)')
    .option('--no-open', 'no abrir el navegador al arrancar')
    .option('--difit-args <args>', 'argumentos extra para las instancias de difit')
    .version('0.1.0');

  program.parse();
  const opts = program.opts<CliOptions>();

  const repoRoot = await tryGit(['rev-parse', '--show-toplevel'], process.cwd());
  if (!repoRoot) {
    console.error('wtv debe ejecutarse dentro de un repositorio git.');
    process.exit(1);
  }

  const difit = new DifitManager({
    extraArgs: opts.difitArgs ? opts.difitArgs.split(/\s+/).filter(Boolean) : [],
  });

  const server = startHub(
    { repoRoot, base: opts.base, difit },
    {
      port: Number(opts.port),
      host: opts.host,
      onListen: ({ port }) => {
        const url = `http://${opts.host}:${port}`;
        console.log(`🌳 worktrees-viewer corriendo en ${url}`);
        console.log(`   dashboard:  ${url}/`);
        console.log(`   para IA:    ${url}/api/review.json · ${url}/review.md`);
        if (opts.open) void openBrowser(url);
      },
    },
  );

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    void difit.stopAll().then(() => {
      server.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exit(1);
});
