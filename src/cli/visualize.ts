// `brackish visualize <doc>` — render the assembled OpenAPI doc in text/markdown/html/openapi/json.

import { writeFileSync } from 'node:fs';
import type { Command } from 'commander';
import type { RationaleEntry } from '../daemon/store/index.js';
import type { RationaleEntryWire } from '../lib/models.js';
import { renderHtml, renderMarkdown, renderText } from '../render/render.js';
import { errExit, withClient } from './common.js';

export function register(program: Command): void {
  program
    .command('visualize <doc>')
    .description('render the current OpenAPI document in text/openapi/markdown/json/html')
    .option('--format <fmt>', 'text|openapi|markdown|json|html', 'text')
    .option('--full', 'text: include operation/schema bodies (default: ToC only)')
    .option('--out <path>', 'write to file instead of stdout')
    .action(async (doc: string, opts: { format: string; full?: boolean; out?: string }) =>
      withClient(async (client) => {
        // assembleDocument falls back to a stub Info block ('Untitled', 0.0.0) when no
        // convention has been accepted. Warn loudly so this isn't mistaken for a complete API.
        const conventionLatest = await client.getConventionLatest(doc).catch(() => null);
        const stubInfo = conventionLatest === null || conventionLatest.status !== 'accepted';
        let banner: string | null = null;
        if (stubInfo) {
          const why =
            conventionLatest === null
              ? 'no convention has been proposed'
              : `convention v${conventionLatest.version} is ${conventionLatest.status}, not accepted`;
          banner = `! convention not accepted (${why}); rendered with stub Info and without any unaccepted convention fields`;
          process.stderr.write(`warning: ${banner}\n`);
        }
        let output: string;
        switch (opts.format) {
          case 'openapi':
            output = await client.getOpenApiYaml(doc);
            if (banner) output = `# ${banner}\n${output}`;
            break;
          case 'json':
            output = `${JSON.stringify(await client.getOpenApiJson(doc), null, 2)}\n`;
            break;
          case 'text':
          case 'markdown':
          case 'html': {
            const document = await client.getOpenApiJson(doc);
            const rationaleJson = await client.getRationaleJson(doc);
            const rationale = {
              endpoints: new Map(
                Object.entries(rationaleJson.endpoints).map(
                  ([k, v]) => [k, v.map(toStoreRationale)] as const,
                ),
              ),
              schemas: new Map(
                Object.entries(rationaleJson.schemas).map(
                  ([k, v]) => [k, v.map(toStoreRationale)] as const,
                ),
              ),
              convention: rationaleJson.convention.map(toStoreRationale),
            };
            if (opts.format === 'text') {
              output = renderText({ document, rationale }, opts.full ? { full: true } : {});
              if (banner) output = `${banner}\n\n${output}`;
            } else if (opts.format === 'markdown') {
              const ev = await client.listEvents(doc, { limit: 1000 });
              output = renderMarkdown({ document, rationale, events: ev.events });
              if (banner) output = `> ${banner}\n\n${output}`;
            } else {
              output = renderHtml({ document, rationale }, { documentName: doc });
              if (banner) output = output.replace(/<body>/, `<body>\n<!-- ${banner} -->`);
            }
            break;
          }
          default:
            errExit(2, `visualize: unknown --format "${opts.format}"`);
        }
        if (opts.out) {
          writeFileSync(opts.out, output);
          process.stderr.write(`wrote ${opts.out}\n`);
        } else {
          process.stdout.write(output);
          if (!output.endsWith('\n')) process.stdout.write('\n');
        }
      }),
    );
}

/** Drop `undefined`-valued optional keys so the wire shape (which zod gives as
 *  `field?: T | undefined`) lines up with the store's exact-optional `RationaleEntry`. */
function toStoreRationale(e: RationaleEntryWire): RationaleEntry {
  const out: RationaleEntry = {
    version: e.version,
    status: e.status,
    proposedBy: e.proposedBy,
    proposedAt: e.proposedAt,
    delta: e.delta,
    spec: e.spec,
  };
  if (e.acceptedBy !== undefined) out.acceptedBy = e.acceptedBy;
  if (e.acceptedAt !== undefined) out.acceptedAt = e.acceptedAt;
  if (e.rejectedBy !== undefined) out.rejectedBy = e.rejectedBy;
  if (e.rejectedAt !== undefined) out.rejectedAt = e.rejectedAt;
  if (e.rejectionReason !== undefined) out.rejectionReason = e.rejectionReason;
  return out;
}
