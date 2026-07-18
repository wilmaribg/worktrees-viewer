# Archivar worktrees + ordenar por fecha (para el daily)

## Objetivo

En un daily standup, poder explicar desde `wtv` en qué se estuvo trabajando:
ordenar los worktrees por **fecha de creación** o por **último commit**, **archivar**
los que ya están terminados (sacándolos de la vista activa sin borrarlos), y por cada
uno mostrar **el cambio** (review con difit, ya existe) y **el PR** si existe.

## Decisiones (tomadas con el usuario)

- **Archivar = ocultar worktrees vivos.** Un flag por worktree lo mueve a una sección
  "Archivados" colapsable. El worktree **sigue en disco** (no se borra). No hay journal
  ni historial que sobreviva al borrado real.
- **Orden**: por creación del worktree o por último commit (last-modified = fecha del
  último commit, no mtime del filesystem).
- **Daily = dashboard reordenado.** Sin endpoint `/daily.md` dedicado.
- **Link del PR = consulta viva con `gh`**, en paralelo, con cache en memoria y
  degradación elegante (sin gh / offline / sin PR → no aparece el link).

## Arquitectura

Extiende módulos existentes; un solo módulo nuevo chico.

### `config.ts`
- `RepoEntry` gana:
  - `archivedWorktrees?: string[]` — ids de worktrees archivados.
  - `sort?: WorktreeSort`.
- `type WorktreeSort = 'created-desc' | 'created-asc' | 'modified-desc' | 'modified-asc'`.
- Funciones:
  - `readRepoArchived(repoRoot): string[]` / `isWorktreeArchived(repoRoot, id): boolean`.
  - `writeRepoArchived(repoRoot, id, archived: boolean)` — agrega/quita el id del array.
  - `readRepoSort(repoRoot): WorktreeSort` (default `'modified-desc'`) / `writeRepoSort`.

### `worktree-dates.ts` (nuevo)
- `worktreeDates(path): Promise<{ createdAt: string | null; lastCommitAt: string | null }>`.
  - `createdAt`: `fs.stat(path).birthtimeMs` → ISO. Fallback: `ctime` → `mtime`. Si todo
    es 0/ inválido → `null`. (macOS/APFS da birthtime real; el usuario está en darwin.)
  - `lastCommitAt`: `git -C <path> log -1 --format=%cI` → ISO. Sin commits / detached sin
    HEAD → `null`.
- Aislado y testeable sobre un repo fixture.

### `pr.ts`
- `lookupPullRequest(branch, cwd): Promise<{ url: string; state: string; number: number } | null>`.
  - Corre `gh pr view <branch> --json url,state,number` con timeout corto.
  - Cualquier fallo (sin PR, gh ausente, offline, no-JSON) → `null`.

### `hub-server.ts`
- `WorktreeReview` gana: `createdAt: string | null`, `lastCommitAt: string | null`,
  `archived: boolean`, `pr: { url; state; number } | null`.
- `aggregate()`:
  - fechas vía `worktreeDates`, `archived` vía `isWorktreeArchived`.
  - PR: `lookupPullRequest` por rama, **en paralelo**, con **cache en memoria** (clave
    `rama@head`, TTL ~60s) para que los refrescos sean baratos. Worktrees sin rama
    (main protegido opcional, detached) → `pr: null`, sin lookup.
- `ReviewAggregate` / `DashboardOptions` propagan `sort`.
- Rutas nuevas:
  - `POST /wt/:id/archive` body `{ archived: boolean }` → persiste, `{ ok, archived }`.
  - `POST /api/sort` body `{ sort: WorktreeSort }` → valida y persiste, `{ ok, sort }`.
- Endpoints machine-readable (`review.json`, `review.md`, `worktrees.json`) incluyen los
  campos nuevos, para que un agente arme el daily desde una sola URL.

### `render.ts`
- `DashboardOptions` gana `sort: WorktreeSort`.
- Control de orden en el toolbar (`<select>` con las 4 opciones) → `POST /api/sort` + reload.
- Worktrees **activos** en el grid, **ordenados** por `sort`; **archivados** dentro de
  `<details class="archived"><summary>Archivados (N)</summary>…</details>` colapsado,
  también ordenados.
- Cada tarjeta:
  - línea de fechas: "creado hace 2d · commit hace 3h" (relativo contra `data.generatedAt`,
    determinista en tests; fallback a "—" si null).
  - badge/link **PR #N (open|merged)** si `wt.pr`.
  - botón **Archivar** / **Desarchivar** (`data-action="archive"`) → `POST /wt/:id/archive` + reload.

## Orden (semántica)
- `created-*` ordena por `createdAt`; `modified-*` por `lastCommitAt`.
- `-desc` = más reciente primero (default `modified-desc`, orden natural del daily).
- Fechas `null` ordenan al final siempre.
- El orden se aplica por separado a activos y a archivados.

## Manejo de errores
- gh ausente / offline / sin PR → `pr: null`, sin link, dashboard intacto.
- birthtime no disponible (Linux) → fallback ctime/mtime; si nada → `null` (ordena al final).
- `POST /api/sort` con valor inválido → 400.
- `POST /wt/:id/archive` con worktree desconocido → 404.

## Testing (TDD)
- `config.test.ts`: archived round-trip (agregar/quitar, no pisa otros campos) + sort
  default `modified-desc` y round-trip.
- `worktree-dates.test.ts`: sobre fixture, `createdAt` no-null y `lastCommitAt` = fecha del
  último commit; repo sin commits → `lastCommitAt` null.
- `pr.test.ts`: `lookupPullRequest` parsea `{url,state,number}`; sin PR / error → null (exec inyectable).
- `hub-server.test.ts`: aggregate incluye los campos; `POST /wt/:id/archive` persiste y 404 si
  desconocido; `POST /api/sort` persiste y 400 si inválido; render mete archivados en `<details>`,
  muestra control de orden, link de PR y fechas; el orden respeta `sort`.

## Fuera de alcance (YAGNI)
- Endpoint `/daily.md` dedicado.
- Journal/historial que sobreviva al borrado del worktree.
- Flags de CLI para sort/archive (se maneja por config del repo).
