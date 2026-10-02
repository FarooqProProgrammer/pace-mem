// Single-file dashboard served at GET /. No build step, no external assets.
// Note for editors: the inner script avoids backticks and "${" so it can live in this template literal.
export const VIEWER_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pace-mem</title>
<style>
  :root {
    --bg: #f6f6f3; --panel: #ffffff; --ink: #1c1c1a; --muted: #6a6a64; --faint: #9a9a92; --line: #e3e2dc;
    --accent: #2f6fde; --accent-ink: #ffffff; --chip: #efeee8; --ok: #1f9d55; --warn: #b7791f; --danger: #d03b33;
    --decision: #8a5cf6; --bugfix: #d9473f; --feature: #1f9d55; --refactor: #c27c0e; --discovery: #2f6fde; --change: #6a6a64;
    --radius: 10px;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #141413; --panel: #1d1d1b; --ink: #ecebe5; --muted: #a09f97; --faint: #74736c; --line: #2d2d2a;
            --accent: #6d9cf0; --accent-ink: #0d1a33; --chip: #282825; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  button, input, select, textarea { font: inherit; color: inherit; }
  a { color: var(--accent); }
  code, pre, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; }

  header { position: sticky; top: 0; z-index: 5; background: var(--bg); border-bottom: 1px solid var(--line); }
  .bar { max-width: 980px; margin: 0 auto; padding: 10px 16px; display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
  h1 { font-size: 16px; margin: 0; letter-spacing: -0.01em; }
  h1 span { color: var(--accent); }
  nav { display: flex; gap: 2px; flex-wrap: wrap; }
  nav a { padding: 6px 12px; border-radius: 8px; color: var(--muted); text-decoration: none; font-weight: 500; }
  nav a:hover { color: var(--ink); background: var(--chip); }
  nav a.active { color: var(--ink); background: var(--panel); box-shadow: 0 0 0 1px var(--line); }
  .live { margin-left: auto; color: var(--muted); font-size: 12px; white-space: nowrap; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--faint); margin-right: 6px; vertical-align: middle; }
  .dot.on { background: var(--ok); }

  main { max-width: 980px; margin: 0 auto; padding: 16px 16px 120px; }
  section[data-tab] { display: none; }
  section[data-tab].active { display: block; }
  h2 { font-size: 15px; margin: 0 0 2px; }
  .lede { color: var(--muted); margin: 0 0 14px; }

  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px; margin: 0 0 14px; }
  .panel > h3 { margin: 0 0 2px; font-size: 14px; }
  .panel > .lede { font-size: 13px; }
  .row { display: grid; grid-template-columns: minmax(0, 220px) minmax(0, 1fr); gap: 6px 20px; padding: 12px 0; border-top: 1px solid var(--line); align-items: start; }
  .row:first-of-type { border-top: 0; }
  .row label.name { font-weight: 500; }
  .hint { color: var(--muted); font-size: 12.5px; margin-top: 4px; }
  .err { color: var(--danger); font-size: 12.5px; margin-top: 4px; }
  @media (max-width: 640px) { .row { grid-template-columns: 1fr; } }

  input[type=text], input[type=number], input[type=password], input[type=search], select {
    background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 7px 10px; width: 100%; max-width: 360px; }
  input:focus, select:focus, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  input.small { max-width: 120px; }

  .btn { border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 7px 14px; cursor: pointer; font-weight: 500; }
  .btn:hover { border-color: var(--faint); }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  .btn.danger { color: var(--danger); }
  .btn.danger.solid { background: var(--danger); border-color: var(--danger); color: #fff; }
  .btn:disabled { opacity: .5; cursor: default; }
  .btn.sm { padding: 3px 10px; font-size: 12.5px; }

  .choices { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 8px; max-width: 560px; }
  .choice { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; cursor: pointer; background: var(--bg); }
  .choice:has(input:checked) { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .choice input { margin: 0 6px 0 0; }
  .choice b { font-weight: 600; }
  .choice div { color: var(--muted); font-size: 12.5px; margin-top: 2px; }

  .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  .seg label { padding: 6px 14px; cursor: pointer; border-left: 1px solid var(--line); }
  .seg label:first-child { border-left: 0; }
  .seg input { display: none; }
  .seg label:has(input:checked) { background: var(--accent); color: var(--accent-ink); }
  .seg.disabled { opacity: .45; pointer-events: none; }

  .switch { position: relative; display: inline-block; width: 38px; height: 22px; vertical-align: middle; }
  .switch input { opacity: 0; width: 0; height: 0; }
  .switch span { position: absolute; inset: 0; background: var(--line); border-radius: 22px; cursor: pointer; transition: .15s; }
  .switch span::before { content: ""; position: absolute; width: 16px; height: 16px; left: 3px; top: 3px; background: #fff; border-radius: 50%; transition: .15s; }
  .switch input:checked + span { background: var(--accent); }
  .switch input:checked + span::before { transform: translateX(16px); }

  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  .chip { display: inline-flex; align-items: center; gap: 4px; background: var(--chip); border-radius: 6px; padding: 2px 4px 2px 8px; font-size: 12.5px; }
  .chip button { border: 0; background: none; cursor: pointer; color: var(--muted); padding: 0 4px; font-size: 14px; line-height: 1; }
  .chip button:hover { color: var(--danger); }
  .inline { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

  .savebar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 6; background: var(--panel); border-top: 1px solid var(--line); transform: translateY(100%); transition: transform .15s; }
  .savebar.show { transform: none; }
  .savebar .bar { justify-content: flex-end; }
  .savebar .msg { margin-right: auto; color: var(--muted); }

  .toast { position: fixed; right: 16px; bottom: 16px; z-index: 10; background: var(--ink); color: var(--bg); padding: 10px 14px; border-radius: 8px; opacity: 0; transform: translateY(8px); transition: .2s; pointer-events: none; max-width: 420px; }
  .toast.show { opacity: 1; transform: none; }
  .toast.bad { background: var(--danger); color: #fff; }

  .banner { border: 1px solid var(--warn); background: color-mix(in srgb, var(--warn) 10%, transparent); border-radius: 8px; padding: 8px 12px; margin: 0 0 14px; font-size: 13px; }
  .result { font-size: 13px; margin-top: 8px; }
  .result.ok { color: var(--ok); } .result.bad { color: var(--danger); }
  pre.preview { background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 12px; max-height: 360px; overflow: auto; white-space: pre-wrap; word-break: break-word; margin: 8px 0 0; }

  .filters { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 4px; }
  .filters input { flex: 1; min-width: 200px; max-width: none; }
  .filters select { width: auto; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 14px; margin: 10px 0; }
  .card.new { animation: flash 1.2s ease-out; }
  @keyframes flash { from { border-color: var(--accent); } }
  .meta { display: flex; gap: 10px; align-items: center; color: var(--muted); font-size: 12px; flex-wrap: wrap; }
  .type { font-weight: 600; text-transform: uppercase; letter-spacing: .04em; font-size: 11px; }
  .meta .actions { margin-left: auto; display: flex; gap: 6px; }
  .title { font-weight: 600; margin: 4px 0 2px; cursor: pointer; }
  .sub { color: var(--muted); }
  .detail { display: none; margin-top: 10px; border-top: 1px solid var(--line); padding-top: 10px; }
  .card.open .detail { display: block; }
  .detail ul { margin: 6px 0; padding-left: 18px; }
  .tag { display: inline-block; background: var(--chip); border-radius: 6px; padding: 1px 7px; margin: 2px 4px 2px 0; font-size: 12px; }
  .files { font-size: 12px; color: var(--muted); word-break: break-all; }
  .summary { border-left: 3px solid var(--accent); }
  .empty { text-align: center; color: var(--muted); padding: 32px 0; }

  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-bottom: 14px; }
  .tile { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 14px; }
  .tile b { display: block; font-size: 22px; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
  .tile span { color: var(--muted); font-size: 12px; }
  .tile.alert b { color: var(--danger); }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 6px; border-top: 1px solid var(--line); vertical-align: middle; }
  th { color: var(--muted); font-weight: 500; font-size: 12px; border-top: 0; }
  td.num { font-variant-numeric: tabular-nums; }
  .kv { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 16px; font-size: 13px; }
  .kv dt { color: var(--muted); }
  .kv dd { margin: 0; word-break: break-all; }
  .status { display: inline-flex; align-items: center; gap: 6px; font-weight: 500; }
  .status.on { color: var(--ok); } .status.off { color: var(--muted); }
  .cmd { display: flex; gap: 8px; align-items: center; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 6px 6px 6px 10px; margin: 6px 0; max-width: 620px; }
  .cmd code { flex: 1; overflow-x: auto; white-space: nowrap; }
</style>
</head>
<body>
<header><div class="bar">
  <h1>pace<span>·</span>mem</h1>
  <nav>
    <a href="#memories" data-nav="memories">Memories</a>
    <a href="#settings" data-nav="settings">Settings</a>
    <a href="#integrations" data-nav="integrations">Integrations</a>
    <a href="#status" data-nav="status">Status</a>
  </nav>
  <div class="live"><span id="dot" class="dot"></span><span id="headline">connecting…</span></div>
</div></header>

<main>
  <!-- ─────────────── Memories ─────────────── -->
  <section data-tab="memories">
    <div class="filters">
      <input id="q" type="search" placeholder="Search memories…" autocomplete="off" aria-label="Search memories">
      <select id="project" aria-label="Project"><option value="">All projects</option></select>
      <select id="type" aria-label="Type">
        <option value="">All types</option><option>decision</option><option>bugfix</option><option>feature</option>
        <option>refactor</option><option>discovery</option><option>change</option>
      </select>
    </div>
    <div id="list"></div>
    <div id="more" class="empty"></div>
  </section>

  <!-- ─────────────── Settings ─────────────── -->
  <section data-tab="settings">
    <h2>Settings</h2>
    <p class="lede">Changes apply to the running worker as soon as you save. They are stored in <code id="settingsPath"></code>.</p>
    <div id="envBanner" class="banner" hidden></div>

    <div class="panel">
      <h3>Compression model</h3>
      <p class="lede">The model that turns raw tool calls into memories and writes session summaries.</p>
      <div class="row">
        <label class="name">Provider</label>
        <div>
          <div class="choices">
            <label class="choice"><input type="radio" name="provider" value="claude-cli"><b>Claude Code login</b>
              <div>Runs <code>claude -p</code>. Usage counts against your Claude plan. Needs Claude Code installed.</div></label>
            <label class="choice"><input type="radio" name="provider" value="anthropic"><b>Anthropic API key</b>
              <div>Calls the API directly and bills your key. Works without Claude Code (e.g. Cursor only).</div></label>
          </div>
          <div class="err" data-err="provider"></div>
        </div>
      </div>
      <div class="row" id="apiKeyRow">
        <label class="name" for="anthropicApiKey">API key</label>
        <div>
          <div class="inline">
            <input id="anthropicApiKey" type="password" autocomplete="off" placeholder="sk-ant-…">
            <button class="btn sm danger" id="removeKey" type="button" hidden>Remove key</button>
          </div>
          <div class="hint" id="keyHint">Leave blank to use the ANTHROPIC_API_KEY environment variable.</div>
          <div class="err" data-err="anthropicApiKey"></div>
        </div>
      </div>
      <div class="row">
        <label class="name" for="modelSelect">Model</label>
        <div>
          <select id="modelSelect">
            <option value="claude-opus-5-5">Claude Opus 5.5: best memories, highest cost</option>
            <option value="claude-sonnet-5-5">Claude Sonnet 5.5: strong and cheaper</option>
            <option value="claude-haiku-4-5">Claude Haiku 4.5: cheapest, fastest</option>
            <option value="__custom">Custom model ID…</option>
          </select>
          <input id="modelCustom" type="text" placeholder="claude-…" style="margin-top:6px" hidden>
          <div class="err" data-err="model"></div>
        </div>
      </div>
      <div class="row">
        <label class="name">Effort</label>
        <div>
          <div class="seg" id="effortSeg">
            <label><input type="radio" name="effort" value="low">Low</label>
            <label><input type="radio" name="effort" value="medium">Medium</label>
            <label><input type="radio" name="effort" value="high">High</label>
          </div>
          <div class="hint" id="effortHint">How hard the model thinks per batch. Low is plenty for summarising tool calls.</div>
        </div>
      </div>
      <div class="row">
        <span class="name">Check</span>
        <div>
          <button class="btn" id="testBtn" type="button">Test connection</button>
          <div class="hint">Makes one tiny call with the <em>saved</em> settings.</div>
          <div class="result" id="testResult"></div>
        </div>
      </div>
    </div>

    <div class="panel">
      <h3>Session context</h3>
      <p class="lede">What a new session sees about earlier work in the same project.</p>
      <div class="row">
        <label class="name" for="contextObservations">Recent observations</label>
        <div><input id="contextObservations" class="small" type="number" min="0" max="200">
          <div class="hint">Listed as a one-line index (~20 tokens each). 0 turns the index off.</div>
          <div class="err" data-err="contextObservations"></div></div>
      </div>
      <div class="row">
        <label class="name" for="contextSummaries">Session summaries</label>
        <div><input id="contextSummaries" class="small" type="number" min="0" max="20">
          <div class="hint">Most recent request summaries, shown in full.</div>
          <div class="err" data-err="contextSummaries"></div></div>
      </div>
      <div class="row">
        <label class="name" for="previewProject">Preview</label>
        <div>
          <select id="previewProject"><option value="">Pick a project…</option></select>
          <div class="hint" id="previewMeta">Shows the injected context using saved settings.</div>
          <pre class="preview" id="preview" hidden></pre>
        </div>
      </div>
    </div>

    <div class="panel">
      <h3>Capture &amp; privacy</h3>
      <p class="lede">What gets recorded, before anything is stored or sent to a model. <code>&lt;private&gt;…&lt;/private&gt;</code> content is always dropped.</p>
      <div class="row">
        <label class="name" for="redactSecrets">Redact secrets</label>
        <div><label class="switch"><input id="redactSecrets" type="checkbox"><span></span></label>
          <div class="hint">Replaces API keys, tokens, private keys and passwords with &lt;redacted/&gt;.</div></div>
      </div>
      <div class="row">
        <label class="name" for="skipInput">Ignored tools</label>
        <div>
          <div class="chips" id="skipChips"></div>
          <div class="inline"><input id="skipInput" type="text" placeholder="Tool name, e.g. WebSearch">
            <button class="btn sm" id="skipAdd" type="button">Add</button></div>
          <div class="hint">Calls to these tools are never recorded. Names are exact (Cursor MCP tools look like <code>MCP:tool</code>).</div>
          <div class="err" data-err="skipTools"></div>
        </div>
      </div>
      <div class="row">
        <label class="name" for="maxPayloadBytes">Max payload size</label>
        <div><div class="inline"><input id="maxPayloadBytes" class="small" type="number" min="1000" max="200000" step="1000"> bytes</div>
          <div class="hint">Per tool input/output. Larger keeps more detail but costs more tokens.</div>
          <div class="err" data-err="maxPayloadBytes"></div></div>
      </div>
    </div>

    <div class="panel">
      <h3>Batching</h3>
      <p class="lede">Tool calls are compressed in batches: fewer, larger model calls cost less.</p>
      <div class="row">
        <label class="name" for="batchSize">Batch size</label>
        <div><input id="batchSize" class="small" type="number" min="1" max="50">
          <div class="hint">Max tool calls per model call.</div><div class="err" data-err="batchSize"></div></div>
      </div>
      <div class="row">
        <label class="name" for="batchDelaySeconds">Quiet period</label>
        <div><div class="inline"><input id="batchDelaySeconds" class="small" type="number" min="0" max="120" step="1"> seconds</div>
          <div class="hint">Wait this long after the last tool call before compressing.</div>
          <div class="err" data-err="batchDelaySeconds"></div></div>
      </div>
    </div>

    <div class="panel">
      <h3>Worker</h3>
      <div class="row">
        <label class="name" for="port">Port</label>
        <div><input id="port" class="small" type="number" min="1024" max="65535">
          <div class="hint">Takes effect after the worker restarts. Hooks and the MCP server read the same setting.</div>
          <div class="err" data-err="port"></div></div>
      </div>
      <div class="row">
        <span class="name">Defaults</span>
        <div class="inline">
          <button class="btn danger" id="resetBtn" type="button">Reset to defaults</button>
          <span id="resetConfirm" hidden>Reset every setting except the API key? <button class="btn sm danger solid" id="resetYes" type="button">Reset</button> <button class="btn sm" id="resetNo" type="button">Cancel</button></span>
        </div>
      </div>
    </div>
  </section>

  <!-- ─────────────── Integrations ─────────────── -->
  <section data-tab="integrations">
    <h2>Integrations</h2>
    <p class="lede">Editors that record into and read from this memory. They all share one database.</p>
    <div class="panel">
      <h3>Claude Code</h3>
      <p class="lede">Installed as a plugin: hooks, the search tools and a skill.</p>
      <div id="ccStatus"></div>
      <div class="hint" style="margin-top:10px">Install or update from a terminal:</div>
      <div class="cmd"><code>claude plugin marketplace add &lt;path-to-pace-mem-repo&gt;</code><button class="btn sm" data-copy type="button">Copy</button></div>
      <div class="cmd"><code>claude plugin install pace-mem@pace-mem</code><button class="btn sm" data-copy type="button">Copy</button></div>
    </div>
    <div class="panel">
      <h3>Cursor</h3>
      <p class="lede">Adds pace-mem hooks and the MCP server to your user Cursor config. Entries from other tools are kept, and the previous files are saved as <code>*.pace-mem.bak</code>.</p>
      <div id="cursorStatus"></div>
      <div class="inline" style="margin-top:10px">
        <button class="btn primary" id="cursorInstall" type="button">Install in Cursor</button>
        <button class="btn danger" id="cursorRemove" type="button">Remove from Cursor</button>
      </div>
      <div class="result" id="cursorResult"></div>
    </div>
  </section>

  <!-- ─────────────── Status ─────────────── -->
  <section data-tab="status">
    <h2>Status</h2>
    <p class="lede" id="workerLine"></p>
    <div class="tiles" id="tiles"></div>
    <div class="panel">
      <h3>Queue</h3>
      <p class="lede">Tool calls that failed to compress 3 times stop retrying. Fix the cause (often the provider or key), then retry them.</p>
      <div class="inline"><button class="btn" id="retryBtn" type="button">Retry failed events</button><span class="result" id="retryResult"></span></div>
    </div>
    <div class="panel">
      <h3>Projects</h3>
      <p class="lede">A project is the folder name of the workspace. Deleting a project removes its memories, summaries, prompts and raw tool calls.</p>
      <div id="projectTable"></div>
    </div>
    <div class="panel">
      <h3>Files</h3>
      <dl class="kv" id="pathsList"></dl>
    </div>
  </section>
</main>

<div class="savebar" id="savebar"><div class="bar">
  <span class="msg" id="saveMsg">Unsaved changes</span>
  <button class="btn" id="discardBtn" type="button">Discard</button>
  <button class="btn primary" id="saveBtn" type="button">Save changes</button>
</div></div>
<div class="toast" id="toast" role="status" aria-live="polite"></div>

<script>
const $ = (s, root) => (root || document).querySelector(s);
const $$ = (s, root) => Array.from((root || document).querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const list = (j) => { try { return JSON.parse(j) || []; } catch (e) { return []; } };
const when = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmt = (n) => Number(n || 0).toLocaleString();

async function api(path, body) {
  const opts = body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const r = await fetch(path, opts);
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) { const e = new Error((data && data.error) || ('HTTP ' + r.status)); e.data = data; throw e; }
  return data;
}

let toastTimer;
function toast(msg, bad) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = 'toast'), 3200);
}

// ── tabs ──────────────────────────────────────────────────────────────
const loaders = {};
function showTab() {
  const name = (location.hash || '#memories').slice(1);
  const tab = $('section[data-tab="' + name + '"]') ? name : 'memories';
  $$('section[data-tab]').forEach((s) => s.classList.toggle('active', s.dataset.tab === tab));
  $$('nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === tab));
  if (loaders[tab]) loaders[tab]();
  updateSavebar();
}
window.addEventListener('hashchange', showTab);

// ── header ────────────────────────────────────────────────────────────
let stats = {};
async function refreshStats() {
  try {
    stats = await api('/api/stats');
    $('#headline').textContent = fmt(stats.observations) + ' memories · ' + fmt(stats.sessions) + ' sessions' + (stats.pending ? ' · ' + stats.pending + ' queued' : '');
    if ($('section[data-tab="status"]').classList.contains('active')) renderTiles();
  } catch (e) { $('#headline').textContent = 'worker unreachable'; }
}

// ── memories ──────────────────────────────────────────────────────────
let oldest = Infinity, loading = false, done = false, searching = false;

function card(o, fresh) {
  const el = document.createElement('div');
  el.className = 'card' + (fresh ? ' new' : '');
  el.dataset.id = o.id;
  const facts = list(o.facts), concepts = list(o.concepts), mod = list(o.files_modified), read = list(o.files_read);
  el.innerHTML =
    '<div class="meta"><span class="type" style="color:var(--' + esc(o.type) + ')">' + esc(o.type) + '</span>' +
    '<span>#' + o.id + '</span><span>' + esc(o.project) + '</span><span>' + when(o.created_at) + '</span>' +
    '<span class="actions"><button class="btn sm danger" data-del type="button">Delete</button></span></div>' +
    '<div class="title">' + esc(o.title) + '</div><div class="sub">' + esc(o.subtitle) + '</div>' +
    '<div class="detail"><div>' + esc(o.narrative) + '</div>' +
    (facts.length ? '<ul>' + facts.map((f) => '<li>' + esc(f) + '</li>').join('') + '</ul>' : '') +
    (concepts.length ? '<div>' + concepts.map((c) => '<span class="tag">' + esc(c) + '</span>').join('') + '</div>' : '') +
    (mod.length ? '<div class="files mono">modified: ' + mod.map(esc).join(', ') + '</div>' : '') +
    (read.length ? '<div class="files mono">read: ' + read.map(esc).join(', ') + '</div>' : '') + '</div>';
  $('.title', el).onclick = () => el.classList.toggle('open');
  $('[data-del]', el).onclick = (ev) => confirmDelete(ev.currentTarget, o.id, el);
  return el;
}

function confirmDelete(btn, id, el) {
  const box = btn.parentElement;
  box.innerHTML = '<span>Delete #' + id + '?</span><button class="btn sm danger solid" type="button">Delete</button><button class="btn sm" type="button">Keep</button>';
  const [yes, no] = $$('button', box);
  no.onclick = () => { box.innerHTML = '<button class="btn sm danger" data-del type="button">Delete</button>'; $('[data-del]', box).onclick = (e) => confirmDelete(e.currentTarget, id, el); };
  yes.onclick = async () => {
    try { await api('/api/observations/delete', { ids: [id] }); el.remove(); toast('Deleted #' + id); refreshStats(); }
    catch (e) { toast(e.message, true); }
  };
}

function summaryCard(s) {
  const el = document.createElement('div');
  el.className = 'card summary open';
  el.innerHTML = '<div class="meta"><span class="type">summary</span><span>' + esc(s.project) + '</span><span>' + when(s.created_at) + '</span></div>' +
    '<div class="title">' + esc(s.request) + '</div><div class="detail">' +
    [['Completed', s.completed], ['Learned', s.learned], ['Next', s.next_steps]].filter((x) => x[1]).map((x) => '<p><b>' + x[0] + ':</b> ' + esc(x[1]) + '</p>').join('') + '</div>';
  return el;
}

function filterQs() {
  const p = $('#project').value, t = $('#type').value;
  return (p ? '&project=' + encodeURIComponent(p) : '') + (t ? '&type=' + encodeURIComponent(t) : '');
}

async function loadMore() {
  if (loading || done || searching) return;
  loading = true; $('#more').textContent = 'Loading…';
  try {
    const t = $('#type').value;
    let rows;
    if (t) {
      // Type filter goes through search, which supports it.
      const r = await api('/api/search?format=json&limit=100' + filterQs());
      rows = r.observations; done = true;
    } else {
      rows = await api('/api/observations?limit=50&before=' + (oldest === Infinity ? '' : oldest) + filterQs());
      done = rows.length < 50;
    }
    rows.forEach((o) => { $('#list').appendChild(card(o)); oldest = Math.min(oldest, o.id); });
    $('#more').textContent = done ? ($('#list').children.length ? '' : 'No memories yet. Work in Claude Code or Cursor and they will appear here.') : '';
  } catch (e) { $('#more').textContent = 'Could not load: ' + e.message; }
  loading = false;
}

function resetList() { $('#list').innerHTML = ''; oldest = Infinity; done = false; }

async function search() {
  const q = $('#q').value.trim();
  resetList();
  if (!q) { searching = false; return loadMore(); }
  searching = true;
  try {
    const r = await api('/api/search?format=json&limit=50&query=' + encodeURIComponent(q) + filterQs());
    r.summaries.forEach((s) => $('#list').appendChild(summaryCard(s)));
    r.observations.forEach((o) => $('#list').appendChild(card(o)));
    $('#more').textContent = r.observations.length || r.summaries.length ? '' : 'No matches.';
  } catch (e) { $('#more').textContent = e.message; }
}

async function loadProjects() {
  const projects = await api('/api/projects/stats');
  for (const sel of [$('#project'), $('#previewProject')]) {
    const keep = sel.value;
    $$('option', sel).slice(1).forEach((o) => o.remove());
    projects.forEach((p) => sel.insertAdjacentHTML('beforeend', '<option>' + esc(p.project) + '</option>'));
    sel.value = keep;
  }
  return projects;
}

// ── settings ──────────────────────────────────────────────────────────
const NUMERIC = ['contextObservations', 'contextSummaries', 'batchSize', 'batchDelaySeconds', 'maxPayloadBytes', 'port'];
const PRESET_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'];
let saved = null, draft = null, settingsMeta = null;

const clone = (o) => JSON.parse(JSON.stringify(o));
const noEffort = (m) => /haiku|sonnet-4-5|claude-3|-4-0|-4-1|-4-2025/.test(m);

async function loadSettings() {
  settingsMeta = await api('/api/settings');
  saved = settingsMeta.settings;
  draft = clone(saved); draft.anthropicApiKey = '';
  $('#settingsPath').textContent = settingsMeta.paths.settings;
  const env = settingsMeta.activeEnvOverrides;
  $('#envBanner').hidden = !env.length;
  $('#envBanner').textContent = env.length ? 'Set by environment variables, which win over these settings when the worker starts: ' + env.join(', ') + '.' : '';
  renderSettings();
}

function renderSettings() {
  $$('input[name=provider]').forEach((r) => (r.checked = r.value === draft.provider));
  $$('input[name=effort]').forEach((r) => (r.checked = r.value === draft.effort));
  const preset = PRESET_MODELS.includes(draft.model);
  $('#modelSelect').value = preset ? draft.model : '__custom';
  $('#modelCustom').hidden = preset;
  if (!preset) $('#modelCustom').value = draft.model;
  NUMERIC.forEach((k) => ($('#' + k).value = draft[k]));
  $('#redactSecrets').checked = !!draft.redactSecrets;
  $('#anthropicApiKey').value = draft.anthropicApiKey || '';
  renderChips(); syncDependent(); clearErrors(); updateSavebar();
}

function syncDependent() {
  const usesApiKey = draft.provider === 'anthropic';
  $('#apiKeyRow').style.display = usesApiKey ? '' : 'none';
  $('#keyHint').textContent = saved.hasApiKey
    ? 'A key ending in ' + saved.apiKeyHint + ' is saved. Type a new one to replace it.'
    : 'Leave blank to use the ANTHROPIC_API_KEY environment variable.';
  $('#removeKey').hidden = !saved.hasApiKey || draft.anthropicApiKey === null;
  const skipEffort = noEffort(draft.model);
  $('#effortSeg').classList.toggle('disabled', skipEffort);
  $('#effortHint').textContent = skipEffort
    ? 'This model does not take an effort setting; it is ignored.'
    : 'How hard the model thinks per batch. Low is plenty for summarising tool calls.';
}

function renderChips() {
  $('#skipChips').innerHTML = draft.skipTools.map((t, i) =>
    '<span class="chip mono">' + esc(t) + '<button type="button" aria-label="Remove ' + esc(t) + '" data-i="' + i + '">×</button></span>').join('')
    || '<span class="hint">No tools ignored.</span>';
  $$('#skipChips button').forEach((b) => (b.onclick = () => { draft.skipTools.splice(Number(b.dataset.i), 1); renderChips(); updateSavebar(); }));
}

function diff() {
  if (!saved || !draft) return {};
  const out = {};
  for (const k of ['provider', 'model', 'effort', 'redactSecrets', 'skipTools'].concat(NUMERIC)) {
    if (JSON.stringify(draft[k]) !== JSON.stringify(saved[k])) out[k] = draft[k];
  }
  if (draft.anthropicApiKey === null) out.anthropicApiKey = '';
  else if (draft.anthropicApiKey) out.anthropicApiKey = draft.anthropicApiKey;
  return out;
}

function updateSavebar() {
  const onSettings = $('section[data-tab="settings"]').classList.contains('active');
  const n = Object.keys(diff()).length;
  $('#savebar').classList.toggle('show', onSettings && n > 0);
  $('#saveMsg').textContent = n === 1 ? '1 unsaved change' : n + ' unsaved changes';
}

function clearErrors() { $$('[data-err]').forEach((e) => (e.textContent = '')); }

function bindSettings() {
  $$('input[name=provider]').forEach((r) => (r.onchange = () => { draft.provider = r.value; syncDependent(); updateSavebar(); }));
  $$('input[name=effort]').forEach((r) => (r.onchange = () => { draft.effort = r.value; updateSavebar(); }));
  $('#modelSelect').onchange = () => {
    const v = $('#modelSelect').value;
    $('#modelCustom').hidden = v !== '__custom';
    if (v === '__custom') { $('#modelCustom').focus(); draft.model = $('#modelCustom').value.trim() || draft.model; }
    else draft.model = v;
    syncDependent(); updateSavebar();
  };
  $('#modelCustom').oninput = () => { draft.model = $('#modelCustom').value.trim(); syncDependent(); updateSavebar(); };
  NUMERIC.forEach((k) => ($('#' + k).oninput = () => { draft[k] = $('#' + k).value === '' ? NaN : Number($('#' + k).value); updateSavebar(); }));
  $('#redactSecrets').onchange = () => { draft.redactSecrets = $('#redactSecrets').checked; updateSavebar(); };
  $('#anthropicApiKey').oninput = () => { draft.anthropicApiKey = $('#anthropicApiKey').value.trim(); updateSavebar(); };
  $('#removeKey').onclick = () => { draft.anthropicApiKey = null; $('#anthropicApiKey').value = ''; syncDependent(); updateSavebar(); toast('Key will be removed when you save'); };
  const addSkip = () => {
    const v = $('#skipInput').value.trim();
    if (v && !draft.skipTools.includes(v)) { draft.skipTools.push(v); renderChips(); updateSavebar(); }
    $('#skipInput').value = '';
  };
  $('#skipAdd').onclick = addSkip;
  $('#skipInput').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); addSkip(); } };

  $('#discardBtn').onclick = () => { draft = clone(saved); draft.anthropicApiKey = ''; renderSettings(); };
  $('#saveBtn').onclick = async () => {
    clearErrors();
    const patch = diff();
    $('#saveBtn').disabled = true;
    try {
      const r = await api('/api/settings', patch);
      saved = r.settings; draft = clone(saved); draft.anthropicApiKey = '';
      renderSettings();
      toast(r.restartRequired ? 'Saved. Restart the worker for the port change.' : 'Saved. Changes are live.');
      $('#testResult').textContent = '';
      if ($('#previewProject').value) loadPreview();
    } catch (e) {
      const issues = (e.data && e.data.issues) || [];
      issues.forEach((i) => { const el = $('[data-err="' + i.field.split('.')[0] + '"]'); if (el) el.textContent = i.message; });
      toast(issues.length ? 'Fix the highlighted fields' : e.message, true);
    }
    $('#saveBtn').disabled = false;
  };

  $('#testBtn').onclick = async () => {
    const out = $('#testResult');
    out.className = 'result'; out.textContent = 'Calling ' + saved.model + '…';
    $('#testBtn').disabled = true;
    try {
      const r = await api('/api/settings/test', {});
      out.className = 'result ' + (r.ok ? 'ok' : 'bad');
      out.textContent = r.ok ? 'Working: ' + r.provider + ' · ' + r.model + ' answered in ' + (r.ms / 1000).toFixed(1) + 's.' : 'Failed: ' + (r.error || 'unexpected answer');
    } catch (e) { out.className = 'result bad'; out.textContent = 'Failed: ' + e.message; }
    $('#testBtn').disabled = false;
  };

  $('#resetBtn').onclick = () => { $('#resetConfirm').hidden = false; $('#resetBtn').hidden = true; };
  $('#resetNo').onclick = () => { $('#resetConfirm').hidden = true; $('#resetBtn').hidden = false; };
  $('#resetYes').onclick = async () => {
    try { const r = await api('/api/settings/reset', {}); saved = r.settings; draft = clone(saved); draft.anthropicApiKey = ''; renderSettings(); toast('Settings reset to defaults'); }
    catch (e) { toast(e.message, true); }
    $('#resetNo').onclick();
  };

  $('#previewProject').onchange = loadPreview;
}

async function loadPreview() {
  const p = $('#previewProject').value;
  const pre = $('#preview');
  if (!p) { pre.hidden = true; return; }
  const text = await api('/api/context?project=' + encodeURIComponent(p));
  pre.hidden = false;
  pre.textContent = text || '(nothing to inject yet for this project)';
  $('#previewMeta').textContent = 'About ' + fmt(Math.ceil(text.length / 4)) + ' tokens, injected at the start of each session in "' + p + '".';
}

window.addEventListener('beforeunload', (e) => { if (Object.keys(diff()).length) { e.preventDefault(); e.returnValue = ''; } });

// ── integrations ──────────────────────────────────────────────────────
function statusLine(on, onText, offText) {
  return '<span class="status ' + (on ? 'on' : 'off') + '"><span class="dot' + (on ? ' on' : '') + '"></span>' + (on ? onText : offText) + '</span>';
}

async function loadIntegrations() {
  try {
    const r = await api('/api/integrations');
    $('#ccStatus').innerHTML = statusLine(r.claudeCode.enabled, 'Plugin installed and enabled', r.claudeCode.installed ? 'Plugin installed but disabled' : 'Plugin not installed');
    renderCursor(r.cursor);
  } catch (e) { $('#cursorStatus').textContent = e.message; }
}

function renderCursor(c) {
  const on = c.hooks.length === 5 && c.mcp;
  const partial = !on && (c.hooks.length || c.mcp);
  $('#cursorStatus').innerHTML = statusLine(on, 'Installed', partial ? 'Partly installed' : 'Not installed') +
    '<div class="hint">Config: <code>' + esc(c.dir) + '</code>' + (c.hooks.length ? ' · hooks: ' + c.hooks.map(esc).join(', ') : '') + (c.mcp ? ' · MCP server' : '') + '</div>';
  $('#cursorInstall').textContent = on ? 'Reinstall / update' : 'Install in Cursor';
  $('#cursorRemove').disabled = !(c.hooks.length || c.mcp);
}

function bindIntegrations() {
  $('#cursorInstall').onclick = async () => {
    const out = $('#cursorResult'); out.className = 'result'; out.textContent = 'Installing…';
    try {
      const r = await api('/api/integrations/cursor/install', {});
      renderCursor(Object.assign({ dir: r.hooksPath.replace(/[\\\\/]hooks\\.json$/, '') }, r.status));
      out.className = 'result ok';
      out.textContent = 'Installed. Reload Cursor to pick up the hooks.' + (r.others.length ? ' Note: ' + r.others.join(', ') + ' is also installed; running two memory tools doubles cost.' : '');
    } catch (e) { out.className = 'result bad'; out.textContent = e.message; }
  };
  $('#cursorRemove').onclick = async () => {
    const out = $('#cursorResult');
    try { await api('/api/integrations/cursor/uninstall', {}); out.className = 'result ok'; out.textContent = 'Removed. Your memories are kept.'; loadIntegrations(); }
    catch (e) { out.className = 'result bad'; out.textContent = e.message; }
  };
  $$('[data-copy]').forEach((b) => (b.onclick = async () => {
    try { await navigator.clipboard.writeText(b.previousElementSibling.textContent); b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy'), 1500); }
    catch (e) { toast('Copy failed; select the text instead', true); }
  }));
}

// ── status ────────────────────────────────────────────────────────────
function renderTiles() {
  const t = [['observations', 'Memories'], ['summaries', 'Summaries'], ['sessions', 'Sessions'], ['prompts', 'Prompts'], ['pending', 'Queued'], ['failed', 'Failed']];
  $('#tiles').innerHTML = t.map((x) => '<div class="tile' + (x[0] === 'failed' && stats.failed ? ' alert' : '') + '"><b>' + fmt(stats[x[0]]) + '</b><span>' + x[1] + '</span></div>').join('');
  $('#retryBtn').disabled = !stats.failed;
}

async function loadStatus() {
  const [h, s, projects] = await Promise.all([api('/api/health'), api('/api/settings'), loadProjects()]);
  $('#workerLine').textContent = 'Worker v' + h.version + ' · pid ' + h.pid + ' · ' + h.provider + ' · ' + h.model;
  await refreshStats(); renderTiles();
  $('#pathsList').innerHTML = [['Data folder', s.paths.data], ['Database', s.paths.db], ['Settings', s.paths.settings], ['Log', s.paths.log]]
    .map((x) => '<dt>' + x[0] + '</dt><dd class="mono">' + esc(x[1]) + '</dd>').join('');
  $('#projectTable').innerHTML = projects.length
    ? '<table><thead><tr><th>Project</th><th>Memories</th><th>Summaries</th><th>Sessions</th><th>Last active</th><th></th></tr></thead><tbody>' +
      projects.map((p) => '<tr><td>' + esc(p.project) + '</td><td class="num">' + fmt(p.observations) + '</td><td class="num">' + fmt(p.summaries) +
        '</td><td class="num">' + fmt(p.sessions) + '</td><td>' + when(p.last_at) + '</td><td style="text-align:right"><button class="btn sm danger" data-proj="' + esc(p.project) + '" type="button">Delete…</button></td></tr>').join('') +
      '</tbody></table>'
    : '<div class="hint">No projects yet.</div>';
  $$('[data-proj]').forEach((b) => (b.onclick = () => askDeleteProject(b)));
}

function askDeleteProject(btn) {
  const name = btn.dataset.proj;
  const cell = btn.parentElement;
  cell.innerHTML = '<div class="inline" style="justify-content:flex-end"><input type="text" placeholder="Type ' + esc(name) + ' to confirm" style="max-width:200px">' +
    '<button class="btn sm danger solid" type="button" disabled>Delete</button><button class="btn sm" type="button">Cancel</button></div>';
  const [input] = $$('input', cell);
  const [del, cancel] = $$('button', cell);
  input.focus();
  input.oninput = () => (del.disabled = input.value !== name);
  cancel.onclick = loadStatus;
  del.onclick = async () => {
    try { const r = await api('/api/projects/delete', { project: name, confirm: input.value }); toast('Deleted ' + name + ' (' + r.deleted + ' memories)'); loadStatus(); resetList(); }
    catch (e) { toast(e.message, true); }
  };
}

$('#retryBtn').onclick = async () => {
  try { const r = await api('/api/retry-failed', {}); $('#retryResult').className = 'result ok'; $('#retryResult').textContent = 'Requeued ' + r.requeued + ' events.'; refreshStats(); }
  catch (e) { toast(e.message, true); }
};

// ── boot ──────────────────────────────────────────────────────────────
let memoriesReady = false;
loaders.memories = () => { if (!memoriesReady) { memoriesReady = true; loadMore(); } };
loaders.settings = () => { loadProjects(); if (!saved) loadSettings().catch((e) => toast(e.message, true)); };
loaders.integrations = loadIntegrations;
loaders.status = () => loadStatus().catch((e) => toast(e.message, true));

async function init() {
  bindSettings(); bindIntegrations();
  await loadProjects().catch(() => {});
  $('#project').onchange = search;
  $('#type').onchange = search;
  let t; $('#q').oninput = () => { clearTimeout(t); t = setTimeout(search, 250); };
  new IntersectionObserver((e) => e[0].isIntersecting && memoriesReady && loadMore()).observe($('#more'));
  refreshStats(); setInterval(refreshStats, 10000);
  showTab();

  const es = new EventSource('/api/stream');
  es.onopen = () => $('#dot').classList.add('on');
  es.onerror = () => $('#dot').classList.remove('on');
  const visible = (o) => !searching && !$('#type').value && (!$('#project').value || $('#project').value === o.project);
  es.addEventListener('observation', (e) => { const o = JSON.parse(e.data); if (memoriesReady && visible(o)) $('#list').prepend(card(o, true)); refreshStats(); });
  es.addEventListener('summary', (e) => { const s = JSON.parse(e.data); if (memoriesReady && visible(s)) $('#list').prepend(summaryCard(s)); refreshStats(); });
}
init();
</script>
</body>
</html>`;
