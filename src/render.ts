// Render an assembled OpenAPI document in one of several formats:
//
//   text     — compact "structure" ToC by default; `--full` inlines bodies
//   openapi  — OpenAPI 3.1 YAML (always full)
//   json     — pretty JSON (always full)
//   markdown — full doc + interleaved negotiation rationale + message transcript
//   html     — single-file Swagger UI page (CDN) + brackish rationale sidebar
//
// All render functions are pure: they take an `OpenAPIDocument` + optional rationale/events,
// emit a string. The server's UI routes hand the same shape to the HTML renderer; visualize
// CLI calls the same functions and writes to stdout/file.

import { stringify as yamlStringify } from 'yaml';
import type { Event } from './models.js';
import type { OpenAPIDocument } from './openapi.js';
import { listOperations } from './openapi.js';
import type { RationaleEntry } from './store/index.js';

export type RationaleMap = {
  endpoints: Map<string, RationaleEntry[]>; // key: '<METHOD> <path>' (uppercase method)
  schemas: Map<string, RationaleEntry[]>; // key: schema name
  convention: RationaleEntry[];
};

export type RenderInput = {
  document: OpenAPIDocument;
  rationale?: RationaleMap;
  events?: Event[];
};

// --- text (structure-only by default) ---

export function renderText(input: RenderInput, opts: { full?: boolean } = {}): string {
  const { document } = input;
  const out: string[] = [];

  out.push(`# ${document.info.title} v${document.info.version}`);
  if (document.info.description) out.push(document.info.description);
  if (document.servers && document.servers.length > 0) {
    out.push('');
    out.push('## Servers');
    for (const s of document.servers) {
      out.push(`  - ${s.url}${s.description ? ` — ${s.description}` : ''}`);
    }
  }

  // endpoints
  const ops = listOperations(document);
  if (ops.length > 0) {
    out.push('');
    out.push('## Endpoints');
    for (const op of ops) {
      const head = `  ${op.method.toUpperCase()} ${op.path}`;
      const summary = op.summary ? `  — ${op.summary}` : '';
      out.push(`${head}${summary}`);
      if (opts.full) {
        const spec = document.paths[op.path]?.[op.method];
        if (spec) out.push(indent(yamlStringify(spec), 4));
      }
    }
  } else {
    out.push('');
    out.push('## Endpoints');
    out.push('  (none accepted yet)');
  }

  // schemas
  const schemas = document.components?.schemas ?? {};
  const schemaNames = Object.keys(schemas);
  if (schemaNames.length > 0) {
    out.push('');
    out.push('## Schemas');
    for (const name of schemaNames) {
      out.push(`  ${name}`);
      if (opts.full) {
        const s = schemas[name];
        if (s) out.push(indent(yamlStringify(s), 4));
      }
    }
  }

  return `${out.join('\n')}\n`;
}

// --- openapi YAML ---

export function renderOpenAPIYaml(input: RenderInput): string {
  return yamlStringify(input.document);
}

// --- JSON ---

export function renderJson(input: RenderInput): string {
  return `${JSON.stringify(input.document, null, 2)}\n`;
}

// --- markdown (full + rationale + transcript) ---

export function renderMarkdown(input: RenderInput): string {
  const { document, rationale, events } = input;
  const out: string[] = [];
  out.push(`# ${document.info.title} v${document.info.version}`);
  if (document.info.description) {
    out.push('');
    out.push(document.info.description);
  }

  if (document.servers && document.servers.length > 0) {
    out.push('');
    out.push('## Servers');
    for (const s of document.servers) {
      out.push(`- ${s.url}${s.description ? ` — ${s.description}` : ''}`);
    }
  }

  // endpoints
  const ops = listOperations(document);
  if (ops.length > 0) {
    out.push('');
    out.push('## Endpoints');
    for (const op of ops) {
      out.push('');
      out.push(`### \`${op.method.toUpperCase()} ${op.path}\``);
      if (op.summary) out.push(op.summary);
      const spec = document.paths[op.path]?.[op.method];
      if (spec) {
        out.push('');
        out.push('```yaml');
        out.push(yamlStringify(spec).trimEnd());
        out.push('```');
      }
      const key = `${op.method.toUpperCase()} ${op.path}`;
      const entries = rationale?.endpoints.get(key);
      if (entries && entries.length > 0) {
        out.push('');
        out.push('**Negotiation history:**');
        for (const e of entries) {
          out.push(`- ${formatRationaleEntry(e)}`);
        }
      }
    }
  }

  // schemas
  const schemas = document.components?.schemas ?? {};
  const schemaNames = Object.keys(schemas).sort();
  if (schemaNames.length > 0) {
    out.push('');
    out.push('## Schemas');
    for (const name of schemaNames) {
      out.push('');
      out.push(`### \`${name}\``);
      const s = schemas[name];
      if (s) {
        out.push('');
        out.push('```yaml');
        out.push(yamlStringify(s).trimEnd());
        out.push('```');
      }
      const entries = rationale?.schemas.get(name);
      if (entries && entries.length > 0) {
        out.push('');
        out.push('**Negotiation history:**');
        for (const e of entries) {
          out.push(`- ${formatRationaleEntry(e)}`);
        }
      }
    }
  }

  // convention rationale
  if (rationale?.convention && rationale.convention.length > 0) {
    out.push('');
    out.push('## Convention history');
    for (const e of rationale.convention) {
      out.push(`- ${formatRationaleEntry(e)}`);
    }
  }

  // message transcript
  const messages = (events ?? []).filter((e) => e.kind === 'message');
  if (messages.length > 0) {
    out.push('');
    out.push('## Discussion transcript');
    for (const m of messages) {
      if (m.kind !== 'message') continue;
      out.push(`- **${m.from}** at ${m.createdAt}: ${m.text}`);
    }
  }

  return `${out.join('\n')}\n`;
}

function formatRationaleEntry(e: RationaleEntry): string {
  const delta = e.delta ? ` (${e.delta})` : '';
  switch (e.status) {
    case 'proposed':
      return `v${e.version} **proposed** by \`${e.proposedBy}\` at ${e.proposedAt}${delta}`;
    case 'accepted':
      return `v${e.version} proposed by \`${e.proposedBy}\` at ${e.proposedAt}${delta}; **accepted** by \`${e.acceptedBy}\` at ${e.acceptedAt}`;
    case 'rejected':
      return `v${e.version} proposed by \`${e.proposedBy}\` at ${e.proposedAt}${delta}; **rejected** by \`${e.rejectedBy}\` at ${e.rejectedAt}: "${e.rejectionReason}"`;
  }
}

// --- html (Swagger UI via CDN + rationale sidebar) ---

export function renderHtml(input: RenderInput, opts: { documentName: string }): string {
  const specJson = JSON.stringify(input.document);
  const rationale = input.rationale ?? { endpoints: new Map(), schemas: new Map(), convention: [] };
  const rationaleJson = JSON.stringify({
    endpoints: Object.fromEntries(rationale.endpoints),
    schemas: Object.fromEntries(rationale.schemas),
    convention: rationale.convention,
  });
  // Inline the rationale JSON so the page works offline once Swagger UI is cached.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>brackish: ${escapeHtml(opts.documentName)}</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
<style>
  body { display: flex; margin: 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
  #swagger-ui { flex: 2; min-width: 0; }
  #rationale { flex: 1; min-width: 360px; padding: 20px 24px; border-left: 1px solid #ddd; background: #fafafa; overflow-y: auto; max-height: 100vh; font-size: 14px; }
  #rationale h1 { font-size: 18px; margin-top: 0; }
  #rationale h2 { font-size: 14px; text-transform: uppercase; color: #666; border-bottom: 1px solid #ddd; padding-bottom: 4px; margin-top: 24px; }
  #rationale h3 { font-size: 14px; margin: 12px 0 4px; font-family: ui-monospace, SFMono-Regular, monospace; }
  /* All sidebar class selectors are scoped under #rationale so they don't clobber Swagger UI's
     own .version / etc. classes on the left pane. */
  #rationale .version { margin: 6px 0; padding: 6px 8px; border-left: 3px solid #ddd; background: #fff; font-size: 12px; }
  #rationale .version.accepted { border-color: #4caf50; }
  #rationale .version.rejected { border-color: #f44336; }
  #rationale .version.proposed { border-color: #2196f3; }
  #rationale .who { color: #666; }
  #rationale .delta { font-family: ui-monospace, monospace; font-size: 11px; color: #555; }
  #rationale .reason { font-style: italic; color: #c62828; }
</style>
</head>
<body>
<div id="swagger-ui"></div>
<div id="rationale">
  <h1>${escapeHtml(opts.documentName)}</h1>
  <p>Negotiation history of this document. The spec on the left is the agreed contract; the right shows how it got there.</p>
  <div id="rationale-content"></div>
</div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>
  const spec = ${specJson};
  SwaggerUIBundle({ spec: spec, dom_id: '#swagger-ui', deepLinking: true, presets: [SwaggerUIBundle.presets.apis] });
  const rationale = ${rationaleJson};
  function escape(s) { return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
  function renderVersion(v) {
    let body = '<div class="version ' + v.status + '">';
    body += 'v' + v.version + ' <span class="who">proposed by ' + escape(v.proposedBy) + '</span>';
    if (v.delta) body += ' <span class="delta">' + escape(v.delta) + '</span>';
    if (v.status === 'accepted') body += '<br><span class="who">accepted by ' + escape(v.acceptedBy) + '</span>';
    if (v.status === 'rejected') body += '<br><span class="who">rejected by ' + escape(v.rejectedBy) + '</span>: <span class="reason">' + escape(v.rejectionReason) + '</span>';
    return body + '</div>';
  }
  function renderGroup(title, map) {
    if (!map || Object.keys(map).length === 0) return '';
    let html = '<h2>' + escape(title) + '</h2>';
    for (const key of Object.keys(map)) {
      html += '<h3>' + escape(key) + '</h3>';
      for (const v of map[key]) html += renderVersion(v);
    }
    return html;
  }
  let body = '';
  body += renderGroup('Endpoints', rationale.endpoints);
  body += renderGroup('Schemas', rationale.schemas);
  if (rationale.convention && rationale.convention.length > 0) {
    body += '<h2>Convention</h2>';
    for (const v of rationale.convention) body += renderVersion(v);
  }
  document.getElementById('rationale-content').innerHTML = body || '<p>(no negotiation history yet)</p>';
</script>
</body>
</html>
`;
}

// --- helpers ---

function indent(s: string, n: number): string {
  const pad = ' '.repeat(n);
  return s
    .split('\n')
    .map((line) => (line.length === 0 ? line : pad + line))
    .join('\n');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
    };
    return map[c] ?? c;
  });
}
