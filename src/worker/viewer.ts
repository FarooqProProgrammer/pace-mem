// Single-file viewer served at GET /. No build step, no external assets.
export const VIEWER_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pace-mem</title>
<style>
  :root {
    --bg: #f7f7f5; --panel: #ffffff; --ink: #1d1d1b; --muted: #6b6b66; --line: #e4e3df;
    --accent: #2f6fde; --chip: #efeee9;
    --decision: #8a5cf6; --bugfix: #d9473f; --feature: #1f9d55; --refactor: #c27c0e; --discovery: #2f6fde; --change: #6b6b66;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #151514; --panel: #1e1e1c; --ink: #ecebe6; --muted: #9a9a93; --line: #2e2e2b; --accent: #6d9cf0; --chip: #2a2a27; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { position: sticky; top: 0; z-index: 2; background: var(--bg); border-bottom: 1px solid var(--line); }
  .bar { max-width: 920px; margin: 0 auto; padding: 12px 16px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  h1 { font-size: 16px; margin: 0 8px 0 0; letter-spacing: -0.01em; }
  h1 span { color: var(--accent); }
  input, select { font: inherit; color: inherit; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; }
  input { flex: 1; min-width: 180px; }
  .stats { color: var(--muted); font-size: 12px; width: 100%; }
  .live { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--muted); margin-right: 6px; vertical-align: middle; }
  .live.on { background: var(--feature); }
  main { max-width: 920px; margin: 0 auto; padding: 12px 16px 64px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; margin: 10px 0; cursor: pointer; }
  .card.new { animation: flash 1.2s ease-out; }
  @keyframes flash { from { border-color: var(--accent); } }
  .meta { display: flex; gap: 8px; align-items: center; color: var(--muted); font-size: 12px; flex-wrap: wrap; }
  .type { font-weight: 600; text-transform: uppercase; letter-spacing: .04em; font-size: 11px; }
  .title { font-weight: 600; margin: 4px 0 2px; }
  .sub { color: var(--muted); }
  .detail { display: none; margin-top: 10px; border-top: 1px solid var(--line); padding-top: 10px; }
  .card.open .detail { display: block; }
  .detail ul { margin: 6px 0; padding-left: 18px; }
  .chip { display: inline-block; background: var(--chip); border-radius: 6px; padding: 1px 7px; margin: 2px 4px 2px 0; font-size: 12px; }
  .files { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); word-break: break-all; }
  .summary { border-left: 3px solid var(--accent); }
  .empty, .more { text-align: center; color: var(--muted); padding: 32px 0; }
</style>
</head>
<body>
<header><div class="bar">
  <h1>pace<span>·</span>mem</h1>
  <select id="project"><option value="">All projects</option></select>
  <input id="q" type="search" placeholder="Search memory…" autocomplete="off">
  <div class="stats"><span id="live" class="live"></span><span id="stats">connecting…</span></div>
</div></header>
<main><div id="list"></div><div id="more" class="more"></div></main>
<script>
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const list = (j) => { try { return JSON.parse(j) || []; } catch { return []; } };
const when = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
let oldest = Infinity, loading = false, done = false, searching = false;

function card(o, fresh) {
  const el = document.createElement('div');
  el.className = 'card' + (fresh ? ' new' : '');
  const facts = list(o.facts), concepts = list(o.concepts), mod = list(o.files_modified), read = list(o.files_read);
  el.innerHTML =
    '<div class="meta"><span class="type" style="color:var(--' + esc(o.type) + ')">' + esc(o.type) + '</span>' +
    '<span>#' + o.id + '</span><span>' + esc(o.project) + '</span><span>' + when(o.created_at) + '</span></div>' +
    '<div class="title">' + esc(o.title) + '</div><div class="sub">' + esc(o.subtitle) + '</div>' +
    '<div class="detail"><div>' + esc(o.narrative) + '</div>' +
    (facts.length ? '<ul>' + facts.map((f) => '<li>' + esc(f) + '</li>').join('') + '</ul>' : '') +
    (concepts.length ? '<div>' + concepts.map((c) => '<span class="chip">' + esc(c) + '</span>').join('') + '</div>' : '') +
    (mod.length ? '<div class="files">modified: ' + mod.map(esc).join(', ') + '</div>' : '') +
    (read.length ? '<div class="files">read: ' + read.map(esc).join(', ') + '</div>' : '') + '</div>';
  el.onclick = () => el.classList.toggle('open');
  return el;
}

function summaryCard(s) {
  const el = document.createElement('div');
  el.className = 'card summary new open';
  el.innerHTML = '<div class="meta"><span class="type">summary</span><span>' + esc(s.project) + '</span><span>' + when(s.created_at) + '</span></div>' +
    '<div class="title">' + esc(s.request) + '</div>' +
    '<div class="detail">' + [['Completed', s.completed], ['Learned', s.learned], ['Next', s.next_steps]]
      .filter((x) => x[1]).map((x) => '<p><b>' + x[0] + ':</b> ' + esc(x[1]) + '</p>').join('') + '</div>';
  return el;
}

async function api(path) { const r = await fetch(path); if (!r.ok) throw new Error(r.status); return r.json(); }

async function loadMore() {
  if (loading || done || searching) return;
  loading = true; $('#more').textContent = 'Loading…';
  const p = $('#project').value;
  const rows = await api('/api/observations?limit=50&before=' + (oldest === Infinity ? '' : oldest) + (p ? '&project=' + encodeURIComponent(p) : ''));
  rows.forEach((o) => { $('#list').appendChild(card(o)); oldest = Math.min(oldest, o.id); });
  done = rows.length < 50;
  $('#more').textContent = done ? ($('#list').children.length ? 'That is everything.' : 'No memories yet. Use Claude Code in a project and they will appear here.') : '';
  loading = false;
}

function reset() { $('#list').innerHTML = ''; oldest = Infinity; done = false; }

async function search() {
  const q = $('#q').value.trim(), p = $('#project').value;
  reset();
  if (!q) { searching = false; return loadMore(); }
  searching = true;
  const r = await api('/api/search?format=json&limit=50&query=' + encodeURIComponent(q) + (p ? '&project=' + encodeURIComponent(p) : ''));
  r.summaries.forEach((s) => $('#list').appendChild(summaryCard(s)));
  r.observations.forEach((o) => $('#list').appendChild(card(o)));
  $('#more').textContent = r.observations.length ? '' : 'No matches.';
}

async function refreshStats() {
  const s = await api('/api/stats');
  $('#stats').textContent = s.observations + ' observations · ' + s.summaries + ' summaries · ' + s.sessions + ' sessions' + (s.pending ? ' · ' + s.pending + ' queued' : '');
}

async function init() {
  const projects = await api('/api/projects');
  projects.forEach((p) => $('#project').insertAdjacentHTML('beforeend', '<option>' + esc(p.project) + '</option>'));
  $('#project').onchange = search;
  let t; $('#q').oninput = () => { clearTimeout(t); t = setTimeout(search, 250); };
  new IntersectionObserver((e) => e[0].isIntersecting && loadMore()).observe($('#more'));
  refreshStats(); setInterval(refreshStats, 10000);
  const es = new EventSource('/api/stream');
  es.onopen = () => $('#live').classList.add('on');
  es.onerror = () => $('#live').classList.remove('on');
  const visible = (o) => !searching && (!$('#project').value || $('#project').value === o.project);
  es.addEventListener('observation', (e) => { const o = JSON.parse(e.data); if (visible(o)) $('#list').prepend(card(o, true)); refreshStats(); });
  es.addEventListener('summary', (e) => { const s = JSON.parse(e.data); if (visible(s)) $('#list').prepend(summaryCard(s)); refreshStats(); });
}
init();
</script>
</body>
</html>`;
