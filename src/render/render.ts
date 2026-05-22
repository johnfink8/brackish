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
import type { RationaleEntry } from '../daemon/store/index.js';
import type { Event } from '../lib/models.js';
import type { OpenAPIDocument } from '../lib/openapi.js';
import { listOperations } from '../lib/openapi.js';

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

const WITHDRAWN_REASON = 'withdrawn by proposer';

function formatRationaleEntry(e: RationaleEntry): string {
  const delta = e.delta ? ` (${e.delta})` : '';
  const head = (() => {
    switch (e.status) {
      case 'proposed':
        return `v${e.version} **proposed** by \`${e.proposedBy}\` at ${e.proposedAt}${delta}`;
      case 'accepted':
        return `v${e.version} proposed by \`${e.proposedBy}\` at ${e.proposedAt}${delta}; **accepted** by \`${e.acceptedBy}\` at ${e.acceptedAt}`;
      case 'rejected':
        if (e.rejectionReason === WITHDRAWN_REASON) {
          return `v${e.version} proposed by \`${e.proposedBy}\` at ${e.proposedAt}${delta}; **↩ withdrawn** by \`${e.rejectedBy}\` at ${e.rejectedAt}`;
        }
        return `v${e.version} proposed by \`${e.proposedBy}\` at ${e.proposedAt}${delta}; **rejected** by \`${e.rejectedBy}\` at ${e.rejectedAt}: "${e.rejectionReason}"`;
    }
  })();
  if (e.spec === undefined || e.spec === null) return head;
  // Indent the YAML so it nests cleanly under the bullet that wraps each entry.
  const body = yamlStringify(e.spec)
    .trimEnd()
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n');
  return `${head}\n  <details><summary>v${e.version} content</summary>\n\n  \`\`\`yaml\n${body}\n  \`\`\`\n  </details>`;
}

// --- html (Swagger UI via CDN + rationale sidebar) ---

export function renderHtml(input: RenderInput, opts: { documentName: string }): string {
  const specJson = JSON.stringify(input.document);
  const rationale = input.rationale ?? { endpoints: new Map(), schemas: new Map(), convention: [] };

  // Pre-render each version's spec to a YAML string so the browser doesn't need a YAML
  // stringifier. The raw spec object is kept too in case callers want it.
  const withYaml = (e: RationaleEntry) => ({
    ...e,
    specYaml: e.spec === undefined || e.spec === null ? '' : yamlStringify(e.spec).trimEnd(),
  });
  const rationaleJson = JSON.stringify({
    endpoints: Object.fromEntries(
      Array.from(rationale.endpoints, ([k, vs]) => [k, vs.map(withYaml)]),
    ),
    schemas: Object.fromEntries(Array.from(rationale.schemas, ([k, vs]) => [k, vs.map(withYaml)])),
    convention: rationale.convention.map(withYaml),
  });
  // Pass the raw event stream through; the client renders it as a chronological timeline,
  // looking up spec bodies in the rationale map for propose events.
  const eventsJson = JSON.stringify(input.events ?? []);
  // Inline the rationale JSON so the page works offline once Swagger UI is cached.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>brackish: ${escapeHtml(opts.documentName)}</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
<style>
  html, body { height: 100%; }
  body { display: flex; margin: 0; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
  #swagger-ui { flex: 2; min-width: 0; overflow-y: auto; }
  #rationale { flex: 1; min-width: 360px; padding: 20px 24px; border-left: 1px solid #ddd; background: #fafafa; overflow-y: auto; font-size: 14px; }
  #rationale h1 { font-size: 18px; margin-top: 0; }
  #rationale h2 { font-size: 14px; text-transform: uppercase; color: #666; border-bottom: 1px solid #ddd; padding-bottom: 4px; margin-top: 24px; }
  #rationale h3 { font-size: 14px; margin: 12px 0 4px; font-family: ui-monospace, SFMono-Regular, monospace; }
  /* All sidebar class selectors are scoped under #rationale so they don't clobber Swagger UI's
     own .version / etc. classes on the left pane. */
  #rationale .ev { margin: 8px 0; padding: 8px 10px; background: #fff; border-left: 3px solid #ddd; border-radius: 2px; font-size: 13px; }
  #rationale .ev.proposed  { border-color: #2196f3; }
  #rationale .ev.accepted  { border-color: #4caf50; }
  #rationale .ev.rejected  { border-color: #f44336; }
  #rationale .ev.withdrawn { border-color: #f9a825; }
  #rationale .ev.message   { border-color: #90a4ae; }
  #rationale .ev .meta { font-size: 11px; color: #666; margin-bottom: 4px; font-family: ui-monospace, SFMono-Regular, monospace; }
  #rationale .ev .meta .who { color: #1976d2; font-weight: 600; }
  #rationale .ev .meta .verb { text-transform: uppercase; letter-spacing: 0.04em; color: #555; }
  #rationale .ev .target { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px; color: #222; }
  #rationale .ev .delta { font-family: ui-monospace, monospace; font-size: 11px; color: #555; margin-top: 2px; }
  #rationale .ev .reason { font-style: italic; color: #c62828; margin-top: 4px; }
  #rationale .ev .reason-note { font-style: italic; color: #2e7d32; margin-top: 4px; }
  #rationale .ev .body { line-height: 1.5; white-space: pre-wrap; word-wrap: break-word; }
  #rationale details.spec { margin-top: 6px; }
  #rationale details.spec > summary { font-size: 11px; color: #1976d2; cursor: pointer; user-select: none; }
  #rationale details.spec > summary:hover { color: #0d47a1; }
  #rationale details.spec > pre { margin: 6px 0 0; padding: 8px; background: #f5f5f5; border-radius: 3px; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 11px; line-height: 1.4; white-space: pre-wrap; word-break: break-word; max-height: 320px; overflow-y: auto; }
</style>
</head>
<body>
<div id="swagger-ui"></div>
<div id="rationale">
  <h1>${escapeHtml(opts.documentName)}</h1>
  <p>Negotiation timeline. The doc on the left is the contract as it stands now; this side is how the two sides got there, in the order it happened.</p>
  <div id="rationale-content"></div>
</div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>
  const spec = ${specJson};
  SwaggerUIBundle({ spec: spec, dom_id: '#swagger-ui', deepLinking: true, presets: [SwaggerUIBundle.presets.apis] });
  const rationale = ${rationaleJson};
  const events = ${eventsJson};
  function escape(s) { return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
  // Build a (kind|identityKey|version) -> rationale-version lookup so propose events can attach
  // the spec body and (for v>=2) the delta string without re-fetching from the server.
  const versionLookup = {};
  for (const v of rationale.convention) versionLookup['convention|convention|' + v.version] = v;
  for (const [name, vs] of Object.entries(rationale.schemas))
    for (const v of vs) versionLookup['schema|' + name + '|' + v.version] = v;
  for (const [key, vs] of Object.entries(rationale.endpoints))
    for (const v of vs) versionLookup['operation|' + key + '|' + v.version] = v;
  function targetLabel(kind, identityKey) {
    if (kind === 'convention') return 'convention';
    if (kind === 'schema') return 'schema ' + identityKey;
    return identityKey; // operation: identity key is already "GET /messages"
  }
  function fmtTime(iso) {
    // Just the HH:MM:SS portion — keeps the meta line compact since wall-clock minutes is what
    // tells the story (the gap between propose and accept).
    const m = /T(\\d\\d:\\d\\d:\\d\\d)/.exec(String(iso));
    return m ? m[1] : String(iso);
  }
  function renderEvent(e) {
    const t = fmtTime(e.createdAt);
    if (e.kind === 'document_created') {
      return '<div class="ev"><div class="meta">' + escape(t) + ' · <span class="who">' + escape(e.by) + '</span> <span class="verb">created document</span></div></div>';
    }
    if (e.kind === 'message') {
      return '<div class="ev message"><div class="meta">' + escape(t) + ' · <span class="who">' + escape(e.from) + '</span></div><div class="body">' + escape(e.text) + '</div></div>';
    }
    const target = targetLabel(e.artifactKind, e.identityKey);
    const v = versionLookup[e.artifactKind + '|' + e.identityKey + '|' + e.version];
    if (e.kind === 'artifact_proposed') {
      const isV1 = e.version === 1;
      const delta = e.delta || (v && v.delta) || '';
      let html = '<div class="ev proposed"><div class="meta">' + escape(t) + ' · <span class="who">' + escape(e.from) + '</span> <span class="verb">proposed</span></div>';
      html += '<div class="target">' + escape(target) + ' v' + e.version + (isV1 ? '' : ' (revision)') + '</div>';
      if (delta) html += '<div class="delta">' + escape(delta) + '</div>';
      if (v && v.specYaml) html += '<details class="spec"><summary>show v' + e.version + ' content</summary><pre>' + escape(v.specYaml) + '</pre></details>';
      return html + '</div>';
    }
    if (e.kind === 'artifact_accepted') {
      let html = '<div class="ev accepted"><div class="meta">' + escape(t) + ' · <span class="who">' + escape(e.from) + '</span> <span class="verb">accepted</span></div>';
      html += '<div class="target">' + escape(target) + ' v' + e.version + '</div>';
      if (e.reason) html += '<div class="reason-note">' + escape(e.reason) + '</div>';
      return html + '</div>';
    }
    if (e.kind === 'artifact_rejected') {
      const isWithdrawn = e.reason === 'withdrawn by proposer';
      const cls = isWithdrawn ? 'withdrawn' : 'rejected';
      const verb = isWithdrawn ? 'withdrew' : 'rejected';
      let html = '<div class="ev ' + cls + '"><div class="meta">' + escape(t) + ' · <span class="who">' + escape(e.from) + '</span> <span class="verb">' + verb + '</span></div>';
      html += '<div class="target">' + escape(target) + ' v' + e.version + '</div>';
      if (!isWithdrawn) html += '<div class="reason">' + escape(e.reason) + '</div>';
      return html + '</div>';
    }
    if (e.kind === 'artifact_withdrawn') {
      return '<div class="ev withdrawn"><div class="meta">' + escape(t) + ' · <span class="who">' + escape(e.from) + '</span> <span class="verb">withdrew</span></div><div class="target">' + escape(target) + ' v' + e.version + '</div></div>';
    }
    return '';
  }
  const html = events.map(renderEvent).join('');
  document.getElementById('rationale-content').innerHTML = html || '<p>(no negotiation history yet)</p>';
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
