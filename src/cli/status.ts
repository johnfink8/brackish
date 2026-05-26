// `brackish status [doc]` — the agent-facing "what am I blocked on?" view.
//
// CLI output is tuned to be instructive (this isn't a human-facing CLI; it's the surface a
// Claude is reading mid-task). Single-doc mode appends a `next:` line nudging the most likely
// verb; multi-doc and no-doc modes give per-doc summaries (similar to `inbox` for messages).

import type { Command } from 'commander';
import type { BrackishClient } from '../client/client.js';
import type { ConventionArtifact } from '../lib/models.js';
import { findBlockingRefs } from '../lib/refs.js';
import { emit, emitJson, type LoadedClientCfg, withClient } from './common.js';

type StatusRow = {
  kind: 'endpoint' | 'schema' | 'convention';
  label: string;
  version: number | null;
  proposedVersion: number | null;
  proposedBy: string | null;
  delta: string | null;
  /** Names of schemas this proposed artifact $refs that aren't yet accepted. Empty
   *  array when no blocking refs (or when the row isn't in-flight). Surfaces as
   *  `(blocked on: X, Y)` in the rendered status so neither side has to send a
   *  plain-text explanation when accepting would fail validation. */
  blockedOn: string[];
};

type AttentionRow = {
  kind: 'convention';
  label: string;
  state: 'rejected' | 'withdrawn';
  version: number;
  by: string;
  reason: string | null;
};

export type DocBuckets = {
  awaitingPeer: StatusRow[];
  awaitingMe: StatusRow[];
  accepted: StatusRow[];
  needsAttention: AttentionRow[];
};

export function register(program: Command): void {
  program
    .command('status [doc]')
    .description(
      'summarize by ownership: awaiting peer, awaiting me, accepted. No doc arg picks the only active doc; with multiple docs, prints a per-doc summary.',
    )
    .option('--verbose', 'also list withdrawn/rejected items')
    .option('--json', 'output JSON (structured buckets)')
    .action(async (doc: string | undefined, opts: { verbose?: boolean; json?: boolean }) =>
      withClient(async (client, cfg) => {
        if (doc !== undefined) {
          await emitSingleDocStatus(client, cfg, doc, opts);
          return;
        }
        const docs = await client.listDocuments();
        if (docs.length === 0) {
          if (opts.json) emitJson({ identity: cfg.identity, documents: [] });
          else emit(`(no documents)\n→ start with: brackish doc new <name>`);
          return;
        }
        if (docs.length === 1) {
          const d = docs[0];
          if (!d) return;
          process.stderr.write(`(only doc is "${d.name}"; pass <doc> to disambiguate later)\n`);
          await emitSingleDocStatus(client, cfg, d.name, opts);
          return;
        }
        await emitMultiDocStatus(
          client,
          cfg,
          docs.map((d) => d.name),
          opts,
        );
      }),
    );
}

async function emitSingleDocStatus(
  client: BrackishClient,
  cfg: LoadedClientCfg,
  doc: string,
  opts: { verbose?: boolean; json?: boolean },
): Promise<void> {
  const me = cfg.identity;
  const buckets = await collectBuckets(client, doc, me);

  if (opts.json) {
    emitJson({
      identity: me,
      awaitingPeer: buckets.awaitingPeer,
      awaitingMe: buckets.awaitingMe,
      accepted: buckets.accepted,
      needsAttention: buckets.needsAttention,
    });
    return;
  }

  const lines: string[] = [`${doc} — your identity = ${me}`];
  const bucket = (header: string, rows: StatusRow[]): void => {
    if (rows.length === 0) return;
    lines.push('');
    lines.push(header);
    for (const r of rows) {
      const v = r.proposedVersion ?? r.version ?? 0;
      const delta = r.delta ? `  ${r.delta}` : r.proposedVersion === 1 ? '  (new)' : '';
      const by = r.proposedBy && r.proposedBy !== me ? ` by ${r.proposedBy}` : '';
      const blocked = r.blockedOn.length > 0 ? `  (blocked on: ${r.blockedOn.join(', ')})` : '';
      lines.push(`  ${r.kind.padEnd(10)} ${r.label.padEnd(36)} v${v}${by}${delta}${blocked}`);
    }
  };
  if (buckets.needsAttention.length > 0) {
    lines.push('', 'needs attention (blocks dependents):');
    for (const a of buckets.needsAttention) {
      const verb = a.state === 'withdrawn' ? 'withdrawn' : 'rejected';
      const tail = a.reason ? `: ${a.reason}` : '';
      lines.push(
        `  ${a.kind.padEnd(10)} ${a.label.padEnd(36)} v${a.version} — ${verb} by ${a.by}${tail}`,
      );
    }
  }
  bucket('awaiting peer review (you proposed):', buckets.awaitingPeer);
  bucket('awaiting your review (peer proposed):', buckets.awaitingMe);
  bucket(`accepted (${buckets.accepted.length}):`, buckets.accepted);
  const totalRows =
    buckets.awaitingPeer.length +
    buckets.awaitingMe.length +
    buckets.accepted.length +
    buckets.needsAttention.length;
  if (totalRows === 0) {
    lines.push(
      '',
      '(nothing yet)',
      `→ start with: brackish propose convention --doc ${doc} --file <convention.yaml>`,
    );
  } else {
    const hint = buildNextHint(doc, buckets);
    if (hint) lines.push('', hint);
  }
  emit(lines.join('\n'));
}

async function emitMultiDocStatus(
  client: BrackishClient,
  cfg: LoadedClientCfg,
  docNames: string[],
  opts: { json?: boolean },
): Promise<void> {
  const me = cfg.identity;
  const perDoc = await Promise.all(
    docNames.map(async (name) => ({ name, buckets: await collectBuckets(client, name, me) })),
  );
  if (opts.json) {
    emitJson({
      identity: me,
      documents: perDoc.map((d) => ({
        name: d.name,
        awaitingPeer: d.buckets.awaitingPeer.length,
        awaitingMe: d.buckets.awaitingMe.length,
        accepted: d.buckets.accepted.length,
        needsAttention: d.buckets.needsAttention.length,
      })),
    });
    return;
  }
  const lines: string[] = [`identity = ${me} — ${perDoc.length} documents:`, ''];
  for (const d of perDoc) {
    const me_ = d.buckets.awaitingMe.length;
    const peer = d.buckets.awaitingPeer.length;
    const acc = d.buckets.accepted.length;
    const att = d.buckets.needsAttention.length;
    const flags: string[] = [];
    if (me_ > 0) flags.push(`awaiting-you=${me_}`);
    if (peer > 0) flags.push(`awaiting-peer=${peer}`);
    if (att > 0) flags.push(`needs-attention=${att}`);
    if (flags.length === 0) flags.push(`accepted=${acc}`);
    lines.push(`  ${d.name.padEnd(24)} ${flags.join('  ')}`);
  }
  const docsAwaiting = perDoc.filter((d) => d.buckets.awaitingMe.length > 0);
  if (docsAwaiting.length > 0) {
    lines.push('', `→ start with: brackish status ${docsAwaiting[0]?.name}`);
  }
  emit(lines.join('\n'));
}

/** Build the status buckets for a single document. Exported for tests; the CLI
 *  entry point above calls this and then renders. */
export async function collectBuckets(
  client: BrackishClient,
  doc: string,
  me: string,
): Promise<DocBuckets> {
  const [endpoints, schemas, conventionCurrent, conventionLatest] = await Promise.all([
    client.listEndpoints(doc),
    client.listSchemas(doc),
    client.getConventionCurrent(doc).catch(() => null),
    client.getConventionLatest(doc).catch(() => null),
  ]);
  const conventionProposed =
    conventionLatest && conventionLatest.status === 'proposed' ? conventionLatest : null;
  const awaitingPeer: StatusRow[] = [];
  const awaitingMe: StatusRow[] = [];
  const accepted: StatusRow[] = [];
  const needsAttention: AttentionRow[] = [];

  const classify = (
    kind: StatusRow['kind'],
    label: string,
    currentVersion: number | null,
    latestProposedVersion: number | null,
    latestProposedBy: string | null,
    latestDelta: string | null,
  ): void => {
    const row: StatusRow = {
      kind,
      label,
      version: currentVersion,
      proposedVersion: latestProposedVersion,
      proposedBy: latestProposedBy,
      delta: latestDelta,
      blockedOn: [],
    };
    const hasInFlight =
      latestProposedVersion !== null && latestProposedVersion > (currentVersion ?? 0);
    if (hasInFlight) {
      if (latestProposedBy === me) awaitingPeer.push(row);
      else awaitingMe.push(row);
    } else if (currentVersion !== null) {
      accepted.push(row);
    }
  };

  for (const e of endpoints) {
    classify(
      'endpoint',
      `${e.method.toUpperCase()} ${e.path}`,
      e.currentVersion,
      e.latestProposedVersion,
      e.latestProposedBy,
      e.latestDelta,
    );
  }
  for (const s of schemas) {
    classify(
      'schema',
      s.name,
      s.currentVersion,
      s.latestProposedVersion,
      s.latestProposedBy,
      s.latestDelta,
    );
  }
  if (conventionCurrent || conventionProposed) {
    const cur = conventionCurrent?.version ?? null;
    const prop = conventionProposed?.version ?? null;
    const propBy = conventionProposed?.status === 'proposed' ? conventionProposed.proposedBy : null;
    classify('convention', 'convention', cur, prop, propBy, null);
  }
  if (
    conventionLatest &&
    conventionLatest.status === 'rejected' &&
    (conventionCurrent === null || conventionLatest.version > conventionCurrent.version)
  ) {
    const isWithdraw = conventionLatest.rejectionReason === 'withdrawn by proposer';
    needsAttention.push(buildAttentionRow(conventionLatest, isWithdraw));
  }

  // Fill in blockedOn for in-flight rows: pull the proposed spec, walk for $ref's,
  // flag refs whose schema doesn't have an accepted version yet. Convention rows
  // can't ref other artifacts so we skip them. The fetches run in parallel; a
  // status with N in-flight rows costs N extra HTTP calls but only when something
  // is actually in motion.
  const acceptedSchemas = new Set(
    schemas.filter((s) => s.currentVersion !== null).map((s) => s.name),
  );
  await Promise.all(
    [...awaitingPeer, ...awaitingMe].map(async (row) => {
      if (row.kind === 'convention') return;
      const spec = await fetchProposedSpec(client, doc, row);
      if (spec === null) return;
      row.blockedOn = findBlockingRefs(spec, acceptedSchemas);
    }),
  );

  return { awaitingPeer, awaitingMe, accepted, needsAttention };
}

/** Fetch the proposed spec for an in-flight status row, or null on lookup failure
 *  (e.g. the proposal was withdrawn between the list call and now). */
async function fetchProposedSpec(
  client: BrackishClient,
  doc: string,
  row: StatusRow,
): Promise<unknown | null> {
  try {
    if (row.kind === 'endpoint') {
      const space = row.label.indexOf(' ');
      if (space < 0) return null;
      const method = row.label.slice(0, space).toLowerCase();
      const path = row.label.slice(space + 1);
      const ep = await client.getEndpoint(
        doc,
        method as Parameters<BrackishClient['getEndpoint']>[1],
        path,
        { proposed: true },
      );
      return ep.spec;
    }
    if (row.kind === 'schema') {
      const sch = await client.getSchema(doc, row.label, { proposed: true });
      return sch.spec;
    }
    return null;
  } catch {
    return null;
  }
}

function buildAttentionRow(c: ConventionArtifact, isWithdraw: boolean): AttentionRow {
  // narrow to the rejected branch so rejectedBy/rejectionReason are typed
  if (c.status !== 'rejected') {
    throw new Error(`buildAttentionRow expected rejected status, got ${c.status}`);
  }
  return {
    kind: 'convention',
    label: 'convention',
    state: isWithdraw ? 'withdrawn' : 'rejected',
    version: c.version,
    by: isWithdraw ? c.proposedBy : c.rejectedBy,
    reason: isWithdraw ? null : c.rejectionReason,
  };
}

/** Suggest the single most-likely next verb. Priority: needs-attention > awaiting-me > awaiting-peer > accepted. */
function buildNextHint(doc: string, b: DocBuckets): string | null {
  if (b.needsAttention.length > 0) {
    return `→ next: clear the needs-attention bucket first (it blocks dependents) — re-propose the convention or accept whatever's stalling it`;
  }
  if (b.awaitingMe.length > 0) {
    // Group awaiting-me by kind for the batch-verb hint.
    const schemas = b.awaitingMe.filter((r) => r.kind === 'schema').map((r) => r.label);
    const endpoints = b.awaitingMe.filter((r) => r.kind === 'endpoint');
    const convention = b.awaitingMe.find((r) => r.kind === 'convention');
    if (convention) {
      return `→ next: brackish accept convention --doc ${doc}   # or reject --rationale "<why>"`;
    }
    if (schemas.length >= 2) {
      const targets = schemas.map((s) => `--target ${s}`).join(' ');
      return `→ next: brackish accept schema --doc ${doc} ${targets}   # batch accept`;
    }
    if (endpoints.length >= 2) {
      const targets = endpoints.map((r) => `--target ${r.label.replace(' ', ':')}`).join(' ');
      return `→ next: brackish accept endpoint --doc ${doc} ${targets}   # batch accept`;
    }
    if (schemas[0]) {
      return `→ next: brackish show schema ${schemas[0]} --doc ${doc}   # then accept or reject`;
    }
    if (endpoints[0]) {
      const [method, path] = endpoints[0].label.split(' ');
      return `→ next: brackish show endpoint ${method} ${path} --doc ${doc}   # then accept or reject`;
    }
  }
  if (b.awaitingPeer.length > 0) {
    return `→ peer has ${b.awaitingPeer.length} of your proposal${b.awaitingPeer.length === 1 ? '' : 's'} pending; brackish nap [--seconds 60] to wait, or move on`;
  }
  if (b.accepted.length > 0 && b.awaitingMe.length === 0 && b.awaitingPeer.length === 0) {
    return (
      `→ current milestone looks settled. If further proposals would be out-of-scope, brackish send ${doc} "<doc> is settled at <milestone>; <X> out of scope — hold for next round"\n` +
      `→ done negotiating? \`brackish down\` stops the daemon so you can focus on implementing the contract.`
    );
  }
  return null;
}
