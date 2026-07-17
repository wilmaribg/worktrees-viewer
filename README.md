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

### Modos de review

El toggle de la cabecera cambia qué se considera "el cambio" en todo el panel (tarjetas, difit y endpoints):

- **Diff del PR**: todo lo que iría en el PR (merge-base con la base → working tree + untracked)
- **Solo sin commitear**: únicamente tu WIP (HEAD → working tree + untracked)

La elección se guarda por repo. Los agentes pueden forzar un modo puntual con `?mode=pr|wip` en cualquier endpoint.

### Levantar el proyecto desde un worktree

Define una vez el **comando dev** en la cabecera (ej. `cd projects/suite && npm run dev`); queda guardado por repo. Cada tarjeta tiene:

- **▶ Levantar**: ejecuta el comando en ese worktree (en su propio process group)
- **Abrir app**: aparece cuando wtv detecta la URL del dev server en los logs (`http://localhost:XXXX`)
- **Detener**: mata el proceso y todos sus hijos
- **logs**: la salida del comando en texto plano (`/wt/:id/run/logs`)

Cada tarjeta tiene además su **propio campo de comando**: en un monorepo cada proyecto se levanta distinto, así que puedes fijar un comando por worktree que sobreescribe al general. El placeholder muestra el comando general; si dejas el campo vacío, ese worktree vuelve a usarlo. El override se guarda por repo y por worktree (`POST /wt/:id/run-command`).

Así puedes probar los cambios de cada worktree antes de crear el PR. Si levantas varios a la vez, la mayoría de dev servers (vite, quasar, webpack) auto-incrementan el puerto solos.

### Crear el Pull Request

El botón **Crear PR** pushea la rama (`git push -u origin`) y crea el PR contra tu base configurada con `gh pr create --fill` (título/cuerpo desde los commits). Si el PR ya existe, abre el existente. Requiere [gh CLI](https://cli.github.com) autenticado. Si hay cambios sin commitear te avisa que no van en el PR.

### Eliminar un worktree

El botón **Eliminar** quita el worktree (`git worktree remove`) cuando ya no lo necesitas, con confirmación y un checkbox opcional para borrar también la rama local. Si hay cambios sin commitear pide forzar explícitamente. Antes de borrar se detienen los procesos asociados (difit y dev server). El worktree principal está protegido.

### Ordenar y archivar (para el daily)

Para explicar en un daily en qué estuviste trabajando, el dashboard tiene un selector **"ordenar"** con cuatro criterios: **último commit** (↓/↑) y **creación** del worktree (↓/↑). El orden se guarda por repo. Cada tarjeta muestra hace cuánto se creó y cuándo fue el último commit, y —si existe— un badge con el **PR** de la rama (`PR #N · estado`, consultado en vivo con `gh`, best-effort).

Cuando terminás con un worktree podés **Archivar**lo: pasa a una sección **Archivados** colapsable al pie, sin borrarlo del disco (podés **Desarchivar** cuando quieras). El default es ordenar por último commit descendente, así lo más reciente queda arriba.

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
| `GET /api/worktrees.json` | Lista ligera sin diffs (para sondeo rápido; incluye `run`, `createdAt`, `lastCommitAt`, `archived` y `pr` de cada worktree) |
| `POST /wt/:id/run/start` · `/run/stop` · `GET /wt/:id/run` | Levantar/detener/consultar el dev server de un worktree |
| `POST /wt/:id/run-command` | Fijar (`{ command }`) o limpiar (`""`) el comando propio de ese worktree |
| `POST /api/sort` | Cambiar el orden del dashboard (`{ sort: 'modified-desc' \| 'modified-asc' \| 'created-desc' \| 'created-asc' }`) |
| `POST /wt/:id/archive` | Archivar/desarchivar un worktree (`{ archived: boolean }`) |
| `POST /wt/:id/pr` | Push + crear el PR con gh (`{ url, created, warning? }`) |
| `POST /wt/:id/delete` | Eliminar el worktree (`{ deleteBranch?, force? }`) |

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

Arquitectura: `src/worktrees.ts` (enumeración), `src/git-summary.ts` (diff/resumen por worktree vía git), `src/worktree-dates.ts` (fechas de creación/último commit para ordenar), `src/difit-manager.ts` (ciclo de vida de los difit hijos), `src/run-manager.ts` (dev servers por worktree), `src/pr.ts` (push + gh pr create + lookup del PR), `src/hub-server.ts` + `src/render.ts` (hub HTTP, dashboard y endpoints), `src/cli.ts` (entrada).

## Licencia

MIT
