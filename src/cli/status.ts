// `brackish status <doc>` — the agent-facing "what am I blocked on?" view.

import type { Command } from 'commander';
import { emit, emitJson, withClient } from './common.js';

type StatusRow = {
  kind: 'endpoint' | 'schema' | 'convention';
  label: string;
  version: number | null;
  proposedVersion: number | null;
  proposedBy: string | null;
  delta: string | null;
};

type AttentionRow = {
  kind: 'convention';
  label: string;
  // withdrawn is a rejected row with reason='withdrawn by proposer' (no separate status).
  state: 'rejected' | 'withdrawn';
  version: number;
  by: string;
  reason: string | null;
};

export function register(program: Command): void {
  program
    .command('status <doc>')
    .description('summarize the document by ownership: awaiting peer, awaiting me, accepted')
    .option('--verbose', 'also list withdrawn/rejected items')
    .option('--json', 'output JSON (structured buckets)')
    .action(async (doc: string, opts: { verbose?: boolean; json?: boolean }) =>
      withClient(async (client, cfg) => {
        const me = cfg.identity;
        const [endpoints, schemas, conventionCurrent, conventionLatest] = await Promise.all([
          client.listEndpoints(doc),
          client.listSchemas(doc),
          client.getConventionCurrent(doc).catch(() => null),
          client.getConventionLatest(doc).catch(() => null),
        ]);
        // `proposed` is "latest is still in flight"; `latest` may also surface a
        // rejected/withdrawn version that current/proposed both hide.
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
          const propBy =
            conventionProposed?.status === 'proposed' ? conventionProposed.proposedBy : null;
          classify('convention', 'convention', cur, prop, propBy, null);
        }
        // Surface a rejected/withdrawn convention as needs-attention. current/proposed both
        // come back null in that state, so the row was previously invisible — and a stalled
        // convention blocks every dependent.
        if (
          conventionLatest &&
          conventionLatest.status === 'rejected' &&
          (conventionCurrent === null || conventionLatest.version > conventionCurrent.version)
        ) {
          const isWithdraw = conventionLatest.rejectionReason === 'withdrawn by proposer';
          needsAttention.push({
            kind: 'convention',
            label: 'convention',
            state: isWithdraw ? 'withdrawn' : 'rejected',
            version: conventionLatest.version,
            by: isWithdraw ? conventionLatest.proposedBy : conventionLatest.rejectedBy,
            reason: isWithdraw ? null : conventionLatest.rejectionReason,
          });
        }

        if (opts.json) {
          emitJson({ identity: me, awaitingPeer, awaitingMe, accepted, needsAttention });
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
            lines.push(`  ${r.kind.padEnd(10)} ${r.label.padEnd(36)} v${v}${by}${delta}`);
          }
        };
        if (needsAttention.length > 0) {
          lines.push('', 'needs attention (blocks dependents):');
          for (const a of needsAttention) {
            const verb = a.state === 'withdrawn' ? 'withdrawn' : 'rejected';
            const tail = a.reason ? `: ${a.reason}` : '';
            lines.push(
              `  ${a.kind.padEnd(10)} ${a.label.padEnd(36)} v${a.version} — ${verb} by ${a.by}${tail}`,
            );
          }
        }
        bucket('awaiting peer review (you proposed):', awaitingPeer);
        bucket('awaiting your review (peer proposed):', awaitingMe);
        bucket(`accepted (${accepted.length}):`, accepted);
        if (
          awaitingPeer.length + awaitingMe.length + accepted.length + needsAttention.length ===
          0
        ) {
          lines.push('', '(nothing yet)');
        }
        emit(lines.join('\n'));
      }),
    );
}
