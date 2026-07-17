import type { ReviewMode, WorktreeSort } from './config.js';
import type { ReviewAggregate, WorktreeReview } from './hub-server.js';

function esc(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function label(wt: WorktreeReview): string {
  if (wt.branch) return wt.branch;
  return wt.detached ? `detached @ ${wt.head.slice(0, 7)}` : wt.id;
}

/** Tiempo relativo compacto contra `nowIso` (p. ej. "hace 3h"), o "—". */
function humanizeAgo(iso: string | null, nowIso: string): string {
  if (!iso) return '—';
  const then = Date.parse(iso);
  const now = Date.parse(nowIso);
  if (Number.isNaN(then) || Number.isNaN(now)) return '—';
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 60) return 'hace segundos';
  const m = Math.floor(s / 60);
  if (m < 60) return `hace ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `hace ${d}d`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `hace ${mo} ${mo === 1 ? 'mes' : 'meses'}`;
  return `hace ${Math.floor(mo / 12)} año(s)`;
}

const PR_STATE_LABELS: Record<string, string> = { OPEN: 'abierto', MERGED: 'merged', CLOSED: 'cerrado' };
function prStateLabel(state: string): string {
  return PR_STATE_LABELS[state] ?? state.toLowerCase();
}

/** Deep link `vscode://file/<ruta>` para abrir el worktree en VS Code (segmentos codificados). */
function vscodeUrl(fsPath: string): string {
  const encoded = fsPath.split('/').map(encodeURIComponent).join('/');
  return `vscode://file${encoded}`;
}

/** Ordena worktrees por la clave elegida; los nulos van siempre al final. */
function sortWorktrees(list: WorktreeReview[], sort: WorktreeSort): WorktreeReview[] {
  const desc = sort.endsWith('desc');
  const created = sort.startsWith('created');
  const ts = (wt: WorktreeReview): number | null => {
    const iso = created ? wt.createdAt : wt.lastCommitAt;
    const ms = iso ? Date.parse(iso) : Number.NaN;
    return Number.isNaN(ms) ? null : ms;
  };
  return [...list].sort((a, b) => {
    const ka = ts(a);
    const kb = ts(b);
    if (ka === null && kb === null) return label(a).localeCompare(label(b));
    if (ka === null) return 1;
    if (kb === null) return -1;
    return desc ? kb - ka : ka - kb;
  });
}

// ---------- Markdown (para IA y humanos) ----------

export function renderReviewMarkdown(data: ReviewAggregate): string {
  const lines: string[] = [
    '# Revisión de worktrees',
    '',
    `- Repo: \`${data.repo}\``,
    `- Generado: ${data.generatedAt}`,
    `- Modo: ${data.mode === 'wip' ? 'solo cambios sin commitear' : 'diff completo del PR'}`,
    `- Worktrees: ${data.worktrees.length}`,
    '',
  ];

  for (const wt of data.worktrees) {
    const s = wt.summary;
    lines.push(`## ${label(wt)}${wt.isMain ? ' (principal)' : ''}`);
    lines.push('');
    lines.push(`- Ruta: \`${wt.path}\``);
    lines.push(`- Base: ${s.baseBranch ? `\`${s.baseBranch}\` (merge-base \`${s.mergeBase?.slice(0, 12)}\`)` : 'sin resolver'}`);
    lines.push(`- Ahead/Behind: ${s.ahead}/${s.behind}`);
    lines.push(`- Cambios: ${s.files.length} archivo(s), +${s.additions} −${s.deletions}`);
    lines.push(`- Sin commitear: ${wt.dirty ? 'sí' : 'no'}`);
    if (s.truncated) lines.push('- ⚠️ Diff truncado por tamaño');
    lines.push('');

    if (s.files.length > 0) {
      lines.push('| Archivo | Estado | + | − |');
      lines.push('|---|---|---|---|');
      for (const f of s.files) {
        lines.push(`| \`${f.path}\` | ${f.status} | ${f.additions} | ${f.deletions} |`);
      }
      lines.push('');
    }

    if (wt.diff && wt.diff.length > 0) {
      lines.push('```diff');
      lines.push(wt.diff);
      lines.push('```');
      lines.push('');
    } else {
      lines.push('_Sin cambios respecto a la base._');
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ---------- Dashboard HTML ----------

function runControlsHtml(wt: WorktreeReview): string {
  const id = esc(wt.id);
  if (wt.run?.running) {
    const appLink = wt.run.url
      ? `<a class="btn ghost" href="${esc(wt.run.url)}" target="_blank" rel="noopener">Abrir app</a>`
      : `<span class="muted esperando" data-wt="${id}">arrancando…</span>`;
    return `${appLink}
    <button class="btn ghost stop" data-action="stop" data-wt="${id}">Detener</button>
    <a class="loglink" href="/wt/${id}/run/logs" target="_blank" rel="noopener">logs</a>`;
  }
  const crashed =
    wt.run && !wt.run.running && wt.run.exitCode !== 0 && wt.run.exitCode !== null
      ? ` <a class="loglink crash" href="/wt/${id}/run/logs" target="_blank" rel="noopener">falló (exit ${wt.run.exitCode}) · logs</a>`
      : '';
  return `<button class="btn ghost" data-action="start" data-wt="${id}">▶ Levantar</button>${crashed}`;
}

function cardHtml(wt: WorktreeReview, generalCommand: string | null, now: string): string {
  const s = wt.summary;
  const badges: string[] = [];
  if (wt.isMain) badges.push('<span class="badge main">principal</span>');
  if (wt.detached) badges.push('<span class="badge">detached</span>');
  if (wt.locked) badges.push('<span class="badge">locked</span>');
  if (wt.dirty) badges.push('<span class="badge dirty">sin commitear</span>');
  if (wt.run?.running) badges.push('<span class="badge running">corriendo</span>');
  if (s.truncated) badges.push('<span class="badge">diff truncado</span>');

  const baseInfo = s.baseBranch
    ? `vs <code>${esc(s.baseBranch)}</code> · ↑${s.ahead} ↓${s.behind}`
    : 'base sin resolver';

  const id = esc(wt.id);
  const canPr = !wt.isMain && !wt.detached && wt.branch !== null;
  const actions: string[] = [
    `<a class="btn" href="/wt/${id}/open" target="_blank" rel="noopener">Abrir review</a>`,
    `<a class="btn ghost" href="${esc(vscodeUrl(wt.path))}" title="Abrir este worktree en VS Code">VS Code</a>`,
    runControlsHtml(wt),
  ];
  if (canPr) {
    actions.push(`<button class="btn ghost" data-action="pr" data-wt="${id}">Crear PR</button>`);
  }
  actions.push(
    `<button class="btn ghost archive" data-action="archive" data-wt="${id}" data-archived="${wt.archived}">${wt.archived ? 'Desarchivar' : 'Archivar'}</button>`,
  );
  if (!wt.isMain) {
    actions.push(
      `<button class="btn danger" data-action="delete" data-wt="${id}" data-label="${esc(label(wt))}" data-branch="${esc(wt.branch ?? '')}" data-dirty="${wt.dirty}">Eliminar</button>`,
    );
  }

  const cmdPlaceholder = generalCommand ? esc(generalCommand) : 'comando para levantar este worktree';
  const cmdInput = `<label class="wt-command-row" title="comando propio de este worktree (vacío = usa el general)">
    <input class="wt-command" data-wt="${id}" type="text" value="${esc(wt.runCommandOverride ?? '')}" placeholder="${cmdPlaceholder}" spellcheck="false">
  </label>`;

  const datesLine = `<p class="wt-dates">creado ${humanizeAgo(wt.createdAt, now)} · último commit ${humanizeAgo(wt.lastCommitAt, now)}</p>`;
  const prLine = wt.pr
    ? `<p class="wt-pr"><a class="pr-link" href="${esc(wt.pr.url)}" target="_blank" rel="noopener">PR #${wt.pr.number} · ${esc(prStateLabel(wt.pr.state))}</a></p>`
    : '';

  return `<article class="card" data-wt="${id}">
  <header>
    <h2>${esc(label(wt))}</h2>
    ${badges.join('\n    ')}
  </header>
  <p class="path" title="${esc(wt.path)}"><code>${esc(wt.path)}</code></p>
  <p class="stats">${baseInfo} · ${s.files.length} archivo(s) <span class="add">+${s.additions}</span> <span class="del">−${s.deletions}</span></p>
  ${datesLine}
  ${prLine}
  ${cmdInput}
  <footer>
    ${actions.join('\n    ')}
  </footer>
</article>`;
}

export interface DashboardOptions {
  /** Ramas locales del repo para el selector de base. */
  branches: string[];
  /** Base efectiva actual (flag, config o auto-detectada). */
  effectiveBase: string | null;
  /** true si la base viene del flag --base (el selector se deshabilita). */
  baseLocked: boolean;
  /** Modo de review actual. */
  mode: ReviewMode;
  /** Comando de arranque configurado para el repo, o null. */
  runCommand: string | null;
  /** Orden actual del dashboard. */
  sort: WorktreeSort;
}

function modeToggleHtml(mode: ReviewMode): string {
  const radio = (value: ReviewMode, label: string) =>
    `<label><input type="radio" name="mode" value="${value}"${mode === value ? ' checked' : ''}>${label}</label>`;
  return `<fieldset id="mode-toggle">
    ${radio('pr', 'Diff del PR')}
    ${radio('wip', 'Solo sin commitear')}
  </fieldset>
  <script>
    document.querySelectorAll('#mode-toggle input').forEach((el) => {
      el.addEventListener('change', async (e) => {
        const res = await fetch('/api/mode', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: e.target.value }),
        });
        if (res.ok) location.reload();
        else alert((await res.json()).error ?? 'no se pudo cambiar el modo');
      });
    });
  </script>`;
}

function baseSelectorHtml(opts: DashboardOptions): string {
  const options = [...opts.branches];
  if (opts.effectiveBase && !options.includes(opts.effectiveBase)) options.unshift(opts.effectiveBase);
  const optionTags = options
    .map((b) => `<option value="${esc(b)}"${b === opts.effectiveBase ? ' selected' : ''}>${esc(b)}</option>`)
    .join('');
  const lockedNote = opts.baseLocked ? ' <span title="fijada por --base">🔒</span>' : '';
  return `<label class="base">comparar contra
    <select id="base-select"${opts.baseLocked ? ' disabled' : ''}>${optionTags}</select>${lockedNote}
  </label>
  <script>
    document.getElementById('base-select').addEventListener('change', async (e) => {
      const res = await fetch('/api/base', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ base: e.target.value }),
      });
      if (res.ok) location.reload();
      else alert((await res.json()).error ?? 'no se pudo cambiar la base');
    });
  </script>`;
}

function sortSelectorHtml(sort: WorktreeSort): string {
  const opt = (value: WorktreeSort, text: string) =>
    `<option value="${value}"${value === sort ? ' selected' : ''}>${text}</option>`;
  return `<label class="sortby">ordenar
    <select id="sort-select">
      ${opt('modified-desc', 'último commit ↓')}
      ${opt('modified-asc', 'último commit ↑')}
      ${opt('created-desc', 'creación ↓')}
      ${opt('created-asc', 'creación ↑')}
    </select>
  </label>
  <script>
    document.getElementById('sort-select').addEventListener('change', async (e) => {
      const res = await fetch('/api/sort', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sort: e.target.value }),
      });
      if (res.ok) location.reload();
      else alert((await res.json()).error ?? 'no se pudo cambiar el orden');
    });
  </script>`;
}

function runCommandHtml(runCommand: string | null): string {
  return `<label class="runcmd">comando dev
    <input id="run-command" type="text" value="${esc(runCommand ?? '')}" placeholder="ej. cd projects/suite &amp;&amp; npm run dev" spellcheck="false">
  </label>
  <script>
    const runCmdInput = document.getElementById('run-command');
    async function saveRunCommand() {
      const command = runCmdInput.value.trim();
      if (!command) return;
      const res = await fetch('/api/run-command', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command }),
      });
      if (!res.ok) alert((await res.json()).error ?? 'no se pudo guardar el comando');
      else runCmdInput.classList.add('saved'), setTimeout(() => runCmdInput.classList.remove('saved'), 800);
    }
    runCmdInput.addEventListener('change', saveRunCommand);
    runCmdInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runCmdInput.blur(); });
  </script>`;
}

const CARD_ACTIONS_JS = `
<dialog id="delete-dialog">
  <form method="dialog">
    <h3>Eliminar worktree</h3>
    <p id="delete-target"></p>
    <label id="delete-branch-row"><input type="checkbox" id="delete-branch-chk"> borrar también la rama local</label>
    <p class="muted small">Los procesos asociados (difit, dev server) se detienen primero.</p>
    <menu>
      <button value="cancel" class="btn ghost">Cancelar</button>
      <button value="confirm" class="btn danger">Eliminar</button>
    </menu>
  </form>
</dialog>
<script>
  async function postJson(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    let data = null;
    try { data = await res.json(); } catch {}
    return { ok: res.ok, status: res.status, data };
  }

  async function pollUntilUrl(wt) {
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const res = await fetch('/wt/' + wt + '/run');
      const status = await res.json();
      if (!status || !status.running || status.url) return;
    }
  }

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const wt = btn.dataset.wt;

    if (btn.dataset.action === 'start') {
      btn.disabled = true;
      btn.textContent = 'arrancando…';
      const { ok, data } = await postJson('/wt/' + wt + '/run/start');
      if (!ok) alert(data?.error ?? 'no se pudo levantar');
      // recargar ya: la tarjeta pasa al estado "corriendo" (con Detener disponible);
      // el handler de .esperando sigue sondeando hasta que aparezca la URL.
      location.reload();
    }

    if (btn.dataset.action === 'stop') {
      btn.disabled = true;
      await postJson('/wt/' + wt + '/run/stop');
      location.reload();
    }

    if (btn.dataset.action === 'archive') {
      btn.disabled = true;
      await postJson('/wt/' + wt + '/archive', { archived: btn.dataset.archived !== 'true' });
      location.reload();
    }

    if (btn.dataset.action === 'pr') {
      btn.disabled = true;
      btn.textContent = 'creando PR…';
      const { ok, data } = await postJson('/wt/' + wt + '/pr');
      btn.disabled = false;
      btn.textContent = 'Crear PR';
      if (!ok) {
        alert(data?.error ?? 'no se pudo crear el PR');
        return;
      }
      if (data.warning) alert('⚠️ ' + data.warning);
      window.open(data.url, '_blank');
    }

    if (btn.dataset.action === 'delete') {
      const dialog = document.getElementById('delete-dialog');
      const chkRow = document.getElementById('delete-branch-row');
      const chk = document.getElementById('delete-branch-chk');
      chk.checked = false;
      chkRow.style.display = btn.dataset.branch ? '' : 'none';
      document.getElementById('delete-target').textContent =
        btn.dataset.label + (btn.dataset.dirty === 'true' ? ' — ⚠️ tiene cambios sin commitear' : '');
      dialog.returnValue = 'cancel';
      dialog.showModal();
      dialog.addEventListener('close', async function onClose() {
        dialog.removeEventListener('close', onClose);
        if (dialog.returnValue !== 'confirm') return;
        let res = await postJson('/wt/' + wt + '/delete', { deleteBranch: chk.checked });
        if (res.status === 409 && res.data?.requiresForce) {
          if (!confirm('Tiene cambios sin commitear que se perderán. ¿Forzar la eliminación?')) return;
          res = await postJson('/wt/' + wt + '/delete', { deleteBranch: chk.checked, force: true });
        }
        if (!res.ok) alert(res.data?.error ?? 'no se pudo eliminar');
        location.reload();
      });
    }
  });

  // input de comando por worktree: guarda el override (vacío = usa el general)
  document.querySelectorAll('.wt-command').forEach((input) => {
    input.addEventListener('change', async () => {
      const command = input.value.trim();
      const res = await fetch('/wt/' + input.dataset.wt + '/run-command', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command }),
      });
      if (!res.ok) alert('no se pudo guardar el comando del worktree');
      else { input.classList.add('saved'); setTimeout(() => input.classList.remove('saved'), 800); }
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
  });

  // tarjetas corriendo pero aún sin URL: esperar a que aparezca y refrescar
  document.querySelectorAll('.esperando').forEach(async (el) => {
    await pollUntilUrl(el.dataset.wt);
    location.reload();
  });
</script>`;

export function renderDashboardHtml(data: ReviewAggregate, opts: DashboardOptions): string {
  const now = data.generatedAt;
  const active = sortWorktrees(
    data.worktrees.filter((w) => !w.archived),
    opts.sort,
  );
  const archived = sortWorktrees(
    data.worktrees.filter((w) => w.archived),
    opts.sort,
  );
  const cards = active.map((wt) => cardHtml(wt, opts.runCommand, now)).join('\n');
  const archivedCards = archived.map((wt) => cardHtml(wt, opts.runCommand, now)).join('\n');
  const archivedSection = archived.length
    ? `<details class="archived">
    <summary>Archivados (${archived.length})</summary>
    <div class="grid">
${archivedCards}
    </div>
  </details>`
    : '';
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>worktrees-viewer</title>
<style>
  :root { color-scheme: light dark; --bg: #0f1115; --card: #191d24; --fg: #e6e9ef; --muted: #8b93a1; --accent: #4f8cff; --green: #3fb950; --red: #f85149; --border: #2a2f3a; }
  @media (prefers-color-scheme: light) { :root { --bg: #f6f8fa; --card: #ffffff; --fg: #1f2328; --muted: #59636e; --border: #d1d9e0; } }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--fg); }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
  h1 { font-size: 1.3rem; margin: 0; }
  .top { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: .4rem; flex-wrap: wrap; }
  .controls { display: flex; align-items: center; gap: .8rem; }
  .base { font-size: .82rem; color: var(--muted); display: flex; align-items: center; gap: .45rem; }
  .base select, .sortby select { background: var(--card); color: var(--fg); border: 1px solid var(--border); border-radius: 7px; padding: .35rem .5rem; font-size: .82rem; }
  .sortby { font-size: .82rem; color: var(--muted); display: flex; align-items: center; gap: .45rem; }
  #mode-toggle { display: flex; gap: 0; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; padding: 0; margin: 0; }
  #mode-toggle label { font-size: .78rem; color: var(--muted); padding: .38rem .7rem; cursor: pointer; }
  #mode-toggle label:has(input:checked) { background: var(--accent); color: #fff; }
  #mode-toggle input { position: absolute; opacity: 0; pointer-events: none; }
  .repo { color: var(--muted); font-size: .85rem; margin: 0 0 1.5rem; overflow-wrap: anywhere; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 1rem; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 1rem 1.1rem; display: flex; flex-direction: column; gap: .55rem; }
  .card header { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
  .card h2 { font-size: 1rem; margin: 0; overflow-wrap: anywhere; }
  .badge { font-size: .68rem; padding: .12rem .5rem; border-radius: 99px; border: 1px solid var(--border); color: var(--muted); }
  .badge.dirty { color: #d29922; border-color: #d29922; }
  .badge.main { color: var(--accent); border-color: var(--accent); }
  .path { margin: 0; font-size: .74rem; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .path code { font-size: inherit; }
  .stats { margin: 0; font-size: .82rem; color: var(--muted); }
  .wt-dates { margin: 0; font-size: .72rem; color: var(--muted); }
  .wt-pr { margin: 0; }
  .pr-link { font-size: .76rem; color: var(--accent); text-decoration: none; border: 1px solid var(--accent); border-radius: 99px; padding: .1rem .5rem; }
  .add { color: var(--green); } .del { color: var(--red); }
  details.archived { margin-top: 1.5rem; border-top: 1px solid var(--border); padding-top: 1rem; }
  details.archived > summary { cursor: pointer; color: var(--muted); font-size: .85rem; margin-bottom: 1rem; }
  details.archived .card { opacity: .72; }
  .card footer { margin-top: auto; padding-top: .35rem; }
  .btn { display: inline-block; background: var(--accent); color: #fff; text-decoration: none; font-size: .82rem; padding: .42rem .9rem; border-radius: 7px; border: none; cursor: pointer; font-family: inherit; }
  .btn.ghost { background: transparent; color: var(--accent); border: 1px solid var(--accent); }
  .btn.danger { background: transparent; color: var(--red); border: 1px solid var(--red); }
  .btn:disabled { opacity: .55; cursor: wait; }
  .card footer { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
  .badge.running { color: var(--green); border-color: var(--green); }
  .loglink { font-size: .75rem; color: var(--muted); }
  .loglink.crash { color: var(--red); }
  .muted { color: var(--muted); font-size: .8rem; }
  .small { font-size: .74rem; }
  .toolbar { margin: .2rem 0 .6rem; }
  .runcmd { font-size: .82rem; color: var(--muted); display: flex; align-items: center; gap: .5rem; }
  .runcmd input { flex: 1; max-width: 480px; background: var(--card); color: var(--fg); border: 1px solid var(--border); border-radius: 7px; padding: .38rem .55rem; font-size: .8rem; font-family: ui-monospace, monospace; }
  .runcmd input.saved { border-color: var(--green); }
  .wt-command-row { display: flex; }
  .wt-command { flex: 1; background: transparent; color: var(--fg); border: 1px solid var(--border); border-radius: 6px; padding: .3rem .5rem; font-size: .74rem; font-family: ui-monospace, monospace; }
  .wt-command:focus { border-color: var(--accent); outline: none; }
  .wt-command.saved { border-color: var(--green); }
  .wt-command::placeholder { color: var(--muted); opacity: .7; }
  #delete-dialog { background: var(--card); color: var(--fg); border: 1px solid var(--border); border-radius: 10px; padding: 1.2rem 1.4rem; max-width: 26rem; }
  #delete-dialog::backdrop { background: rgba(0,0,0,.55); }
  #delete-dialog h3 { margin: 0 0 .6rem; font-size: 1rem; }
  #delete-dialog label { display: flex; align-items: center; gap: .45rem; font-size: .85rem; margin: .6rem 0; }
  #delete-dialog menu { display: flex; justify-content: flex-end; gap: .6rem; padding: 0; margin: 1rem 0 0; }
  .ai { margin-top: 2.2rem; border-top: 1px solid var(--border); padding-top: 1.2rem; font-size: .85rem; color: var(--muted); }
  .ai code { background: var(--card); border: 1px solid var(--border); border-radius: 5px; padding: .12rem .4rem; }
  .ai h3 { color: var(--fg); font-size: .95rem; margin: 0 0 .5rem; }
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <h1>🌳 worktrees-viewer</h1>
    <div class="controls">
      ${modeToggleHtml(opts.mode)}
      ${sortSelectorHtml(opts.sort)}
      ${baseSelectorHtml(opts)}
      <a class="btn ghost" href="/">Refrescar</a>
    </div>
  </div>
  <div class="toolbar">
    ${runCommandHtml(opts.runCommand)}
  </div>
  <p class="repo">${esc(data.repo)} · ${data.worktrees.length} worktree(s) · ${esc(data.generatedAt)}</p>
  <div class="grid">
${cards}
  </div>
  ${archivedSection}
  <div class="ai">
    <h3>Para agentes de IA</h3>
    <p>Todo el contenido agregado (todos los worktrees con sus diffs) está disponible en:</p>
    <p><code>GET /api/review.json</code> — estructurado · <code>GET /review.md</code> — markdown · <code>GET /api/worktrees.json</code> — lista sin diffs</p>
  </div>
</div>
${CARD_ACTIONS_JS}
</body>
</html>`;
}
