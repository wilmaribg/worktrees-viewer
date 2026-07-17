# worktrees-viewer (`wtv`)

Panel local para revisar los diffs de **todos tus git worktrees** antes de crear un Pull Request — con endpoints machine-readable para que un agente de IA (Claude Code, etc.) pueda leer todos los cambios desde una sola URL.

Los visores de diff locales existentes revisan un solo diff a la vez. `wtv` añade la capa que faltaba: enumera todos los worktrees de tu repo en un dashboard y delega la revisión de cada uno a [difit](https://github.com/yoshiko-pg/difit) (visor tipo GitHub).

## Uso

```bash
# dentro de cualquier repo git (o de cualquiera de sus worktrees)
npx worktrees-viewer
# o instalado globalmente
npm i -g worktrees-viewer
wtv
```

Se abre el navegador con el dashboard: una tarjeta por worktree con rama, base, ahead/behind, archivos cambiados, `+/-` y si hay cambios sin commitear. El botón **Abrir review** lanza difit para ese worktree mostrando el **diff del PR** (contra el merge-base con la rama base) **más los cambios sin commitear y archivos untracked**.

### Rama base

En la cabecera del dashboard hay un selector **"comparar contra"** con las ramas locales del repo. Al cambiarlo, la elección se guarda en `~/.config/wtv/config.json` (keyed por repo) y se recuerda en próximos arranques. Precedencia:

1. Flag `--base <rama>` (fija la base para esa sesión; el selector se muestra con 🔒)
2. Base guardada en la config del usuario para ese repo
3. Auto-detección: `origin/HEAD` → `main` → `master`

### Flags

| Flag | Default | Descripción |
|---|---|---|
| `-p, --port <port>` | 4900 | Puerto del hub |
| `--host <host>` | 127.0.0.1 | Host donde escuchar |
| `-b, --base <branch>` | auto | Rama base para los diffs (fija la base y deshabilita el selector) |
| `--no-open` | — | No abrir el navegador |
| `--difit-args "<args>"` | — | Argumentos extra para las instancias de difit |

## Para agentes de IA

Todo el contenido agregado está disponible en URLs estables:

| Endpoint | Contenido |
|---|---|
| `GET /api/review.json` | Todos los worktrees con metadata, archivos y **diffs completos** (JSON) |
| `GET /review.md` | Lo mismo en Markdown legible |
| `GET /api/worktrees.json` | Lista ligera sin diffs (para sondeo rápido) |

Ejemplo con Claude Code:

```
Lee http://127.0.0.1:4900/review.md y revisa los cambios de cada worktree
antes de que cree los PRs. Señala bugs y mejoras.
```

Los diffs muy grandes se truncan (2 MB por worktree) y se marcan con `"truncated": true`.

## Notas

- Los servidores difit se lanzan de forma perezosa (al abrir un review) y mueren junto con el hub (Ctrl+C).
- difit usa `git add --intent-to-add` para mostrar archivos untracked; lo deshace con `git reset -- <archivos>` (difit lo indica en su salida).
- Requiere Node ≥ 20 y git.

## Desarrollo

```bash
npm install
npm test            # vitest (unit + e2e)
npm run typecheck
npm run build       # tsup → dist/
npm run dev         # tsx src/cli.ts
```

Arquitectura: `src/worktrees.ts` (enumeración), `src/git-summary.ts` (diff/resumen por worktree vía git), `src/difit-manager.ts` (ciclo de vida de los difit hijos), `src/hub-server.ts` + `src/render.ts` (hub HTTP, dashboard y endpoints), `src/cli.ts` (entrada).

## Licencia

MIT
