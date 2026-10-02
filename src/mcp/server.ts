/**
 * MCP server (stdio). A thin translation layer: every tool is one call to the
 * worker's HTTP API, which owns all search logic.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { OBSERVATION_TYPES } from '../shared/types.js';
import { ensureWorker, request } from '../shared/worker-client.js';

const server = new McpServer({ name: 'pace-mem', version: '0.1.0' });

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

async function call(path: string, body?: unknown): Promise<ToolResult> {
  try {
    if (!(await ensureWorker(5000))) throw new Error('the pace-mem worker is not running and could not be started');
    const res = await request(path, { body, timeoutMs: 15_000 });
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      try {
        message = JSON.parse(text).error ?? text;
      } catch {}
      return { content: [{ type: 'text', text: `pace-mem error: ${message}` }], isError: true };
    }
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `pace-mem error: ${(err as Error).message}` }], isError: true };
  }
}

function qs(params: Record<string, unknown>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  return q.toString();
}

server.registerTool(
  'search',
  {
    title: 'Search memory',
    description:
      'Step 1 of 3. Full-text search over observations from past Claude Code sessions (decisions, bug fixes, discoveries, changes). ' +
      'Returns a compact index of IDs and titles (~50 tokens per hit), plus matching session summaries. ' +
      'Use it before re-investigating something that may have been done before. Then call `timeline` or `get_observations` with the IDs that look relevant.',
    inputSchema: {
      query: z.string().optional().describe('Words to search for. Omit to list the most recent observations.'),
      project: z.string().optional().describe('Project name (the folder name of the repo). Omit to search all projects.'),
      type: z.enum(OBSERVATION_TYPES).optional().describe('Only this observation type'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results, default 20'),
      offset: z.number().int().min(0).optional(),
      dateStart: z.string().optional().describe('ISO date, e.g. 2026-09-01'),
      dateEnd: z.string().optional().describe('ISO date'),
    },
    annotations: { readOnlyHint: true },
  },
  (args) => call(`/api/search?${qs(args)}`),
);

server.registerTool(
  'timeline',
  {
    title: 'Memory timeline',
    description:
      'Step 2 of 3. Shows what happened before and after one observation in the same project, to understand the context of a search hit. ' +
      'Pass `anchor` (an observation ID from search) or `query` (the best match becomes the anchor).',
    inputSchema: {
      anchor: z.number().int().optional().describe('Observation ID to center on'),
      query: z.string().optional().describe('Used to find the anchor when no ID is given'),
      depth_before: z.number().int().min(0).max(20).optional().describe('Observations before the anchor, default 3'),
      depth_after: z.number().int().min(0).max(20).optional().describe('Observations after the anchor, default 3'),
      project: z.string().optional(),
    },
    annotations: { readOnlyHint: true },
  },
  (args) => call(`/api/timeline?${qs(args)}`),
);

server.registerTool(
  'get_observations',
  {
    title: 'Get observation details',
    description:
      'Step 3 of 3. Full details (narrative, facts, files) for specific observation IDs. ' +
      'Only fetch IDs you picked from `search` or `timeline`; each costs ~300-800 tokens.',
    inputSchema: {
      ids: z.array(z.number().int()).min(1).max(50).describe('Observation IDs, e.g. [123, 456]'),
      project: z.string().optional(),
    },
    annotations: { readOnlyHint: true },
  },
  (args) => call('/api/observations/batch', args),
);

await server.connect(new StdioServerTransport());
