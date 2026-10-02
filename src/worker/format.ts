import type { ObservationRow, SummaryRow } from '../db/store.js';

const TYPE_ICON: Record<string, string> = {
  decision: '⚖️',
  bugfix: '🐞',
  feature: '✨',
  refactor: '♻️',
  discovery: '🔎',
  change: '✏️',
};

const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const time = (t: number) => new Date(t).toTimeString().slice(0, 5);
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

function parseList(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** Compact index grouped by day; the order of rows is preserved (relevance or recency). */
export function indexTable(rows: ObservationRow[], withProject = false): string {
  if (rows.length === 0) return '_No observations._';
  const groups = new Map<string, ObservationRow[]>();
  for (const r of rows) {
    const d = day(r.created_at);
    groups.set(d, [...(groups.get(d) ?? []), r]);
  }
  const out: string[] = [];
  for (const [d, group] of groups) {
    out.push(`### ${d}`, '', `| ID | Time | Type | Title${withProject ? ' | Project' : ''} |`, `|---|---|---|---${withProject ? '|---' : ''}|`);
    for (const r of group) {
      out.push(
        `| #${r.id} | ${time(r.created_at)} | ${TYPE_ICON[r.type] ?? ''} ${r.type} | ${cell(r.title)}${withProject ? ` | ${cell(r.project)}` : ''} |`,
      );
    }
    out.push('');
  }
  return out.join('\n').trimEnd();
}

export function fullObservation(o: ObservationRow): string {
  const facts = parseList(o.facts);
  const concepts = parseList(o.concepts);
  const read = parseList(o.files_read);
  const modified = parseList(o.files_modified);
  return [
    `## #${o.id} ${TYPE_ICON[o.type] ?? ''} ${o.title}`,
    `_${o.type} · ${o.project} · ${day(o.created_at)} ${time(o.created_at)} · session ${o.session_id}, prompt ${o.prompt_number}_`,
    o.subtitle && `\n${o.subtitle}`,
    o.narrative && `\n${o.narrative}`,
    facts.length ? `\n**Facts**\n${facts.map((f) => `- ${f}`).join('\n')}` : '',
    modified.length ? `\n**Modified:** ${modified.join(', ')}` : '',
    read.length ? `**Read:** ${read.join(', ')}` : '',
    concepts.length ? `**Concepts:** ${concepts.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function summaryBlock(s: SummaryRow): string {
  const lines = [`### ${day(s.created_at)} ${time(s.created_at)} — ${cell(s.request) || 'Session'}`];
  if (s.completed) lines.push(`- **Completed:** ${s.completed}`);
  if (s.learned) lines.push(`- **Learned:** ${s.learned}`);
  if (s.next_steps) lines.push(`- **Next steps:** ${s.next_steps}`);
  return lines.join('\n');
}

/** Markdown injected at SessionStart. Kept small: an index, not the full history. */
export function sessionContext(project: string, summaries: SummaryRow[], observations: ObservationRow[]): string {
  if (summaries.length === 0 && observations.length === 0) return '';
  const parts = [
    `# pace-mem — memory for "${project}"`,
    'What earlier sessions in this project did. This is an index: when a past item is relevant, fetch details with the pace-mem MCP tools ' +
      '(`search` → `timeline` → `get_observations` with the IDs below) instead of re-reading files.',
  ];
  if (summaries.length) parts.push('## Recent session summaries', ...summaries.map(summaryBlock));
  if (observations.length) parts.push('## Recent observations (newest first)', indexTable(observations));
  return parts.join('\n\n');
}
