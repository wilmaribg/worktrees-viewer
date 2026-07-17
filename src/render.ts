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

// ---------- Markdown (para IA y humanos) ----------

export function renderReviewMarkdown(data: ReviewAggregate): string {
  const lines: string[] = [
    '# Revisión de worktrees',
    '',
    `- Repo: \`${data.repo}\``,
    `- Generado: ${data.generatedAt}`,
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

function cardHtml(wt: WorktreeReview): string {
  const s = wt.summary;
  const badges: string[] = [];
  if (wt.isMain) badges.push('<span class="badge main">principal</span>');
  if (wt.detached) badges.push('<span class="badge">detached</span>');
  if (wt.locked) badges.push('<span class="badge">locked</span>');
  if (wt.dirty) badges.push('<span class="badge dirty">sin commitear</span>');
  if (s.truncated) badges.push('<span class="badge">diff truncado</span>');

  const baseInfo = s.baseBranch
    ? `vs <code>${esc(s.baseBranch)}</code> · ↑${s.ahead} ↓${s.behind}`
    : 'base sin resolver';

  return `<article class="card">
  <header>
    <h2>${esc(label(wt))}</h2>
    ${badges.join('\n    ')}
  </header>
  <p class="path" title="${esc(wt.path)}"><code>${esc(wt.path)}</code></p>
  <p class="stats">${baseInfo} · ${s.files.length} archivo(s) <span class="add">+${s.additions}</span> <span class="del">−${s.deletions}</span></p>
  <footer>
    <a class="btn" href="/wt/${esc(wt.id)}/open" target="_blank" rel="noopener">Abrir review</a>
  </footer>
</article>`;
}

export function renderDashboardHtml(data: ReviewAggregate): string {
  const cards = data.worktrees.map(cardHtml).join('\n');
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
  .top { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: .4rem; }
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
  .add { color: var(--green); } .del { color: var(--red); }
  .card footer { margin-top: auto; padding-top: .35rem; }
  .btn { display: inline-block; background: var(--accent); color: #fff; text-decoration: none; font-size: .82rem; padding: .42rem .9rem; border-radius: 7px; }
  .btn.ghost { background: transparent; color: var(--accent); border: 1px solid var(--accent); }
  .ai { margin-top: 2.2rem; border-top: 1px solid var(--border); padding-top: 1.2rem; font-size: .85rem; color: var(--muted); }
  .ai code { background: var(--card); border: 1px solid var(--border); border-radius: 5px; padding: .12rem .4rem; }
  .ai h3 { color: var(--fg); font-size: .95rem; margin: 0 0 .5rem; }
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <h1>🌳 worktrees-viewer</h1>
    <a class="btn ghost" href="/">Refrescar</a>
  </div>
  <p class="repo">${esc(data.repo)} · ${data.worktrees.length} worktree(s) · ${esc(data.generatedAt)}</p>
  <div class="grid">
${cards}
  </div>
  <div class="ai">
    <h3>Para agentes de IA</h3>
    <p>Todo el contenido agregado (todos los worktrees con sus diffs) está disponible en:</p>
    <p><code>GET /api/review.json</code> — estructurado · <code>GET /review.md</code> — markdown · <code>GET /api/worktrees.json</code> — lista sin diffs</p>
  </div>
</div>
</body>
</html>`;
}
