// Compact text formatters for the agent-facing CLI output. JSON is the simple path
// (JSON.stringify of whatever the API returns); these helpers handle the text path,
// which we default to because it's denser in the agent's context window.

import type { LintIssue } from '../lib/lint.js';
import type {
  ConventionArtifact,
  Document,
  EndpointSummary,
  Event,
  InboxEntry,
  OperationArtifact,
  Party,
  SchemaArtifact,
  SchemaSummary,
} from '../lib/models.js';

const trim = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** Strip subsecond precision for compactness; otherwise we burn 4 chars on ".XXXZ". */
const shortDate = (iso: string): string => iso.replace(/\.\d+Z$/, 'Z');

const eventPreview = (e: Event): string => {
  switch (e.kind) {
    case 'message':
      // Don't truncate chat bodies — they're the substantive payload, not row metadata.
      // Multi-line spills are fine; the next event starts with an id column that re-anchors.
      return e.text;
    case 'artifact_proposed': {
      const delta = e.delta ? ` ${trim(e.delta, 60)}` : '';
      return `${e.artifactKind} ${e.identityKey} v${e.version}${delta}`;
    }
    case 'artifact_accepted':
      return e.reason
        ? `${e.artifactKind} ${e.identityKey} v${e.version}: ${trim(e.reason, 60)}`
        : `${e.artifactKind} ${e.identityKey} v${e.version}`;
    case 'artifact_rejected':
      return `${e.artifactKind} ${e.identityKey} v${e.version}: ${trim(e.reason, 60)}`;
    case 'artifact_withdrawn':
      return `${e.artifactKind} ${e.identityKey} v${e.version} (withdrawn by proposer)`;
    case 'document_created':
      return `created by ${e.by}`;
  }
};

const eventFrom = (e: Event): string => {
  if ('from' in e) return e.from;
  if (e.kind === 'document_created') return e.by;
  return '-';
};

export function formatEvents(events: Event[], cursor: number): string {
  if (events.length === 0) return `(no new events)\ncursor: ${cursor}`;
  const lines = events.map(
    (e) =>
      `${pad(e.id, 5)}  ${shortDate(e.createdAt)}  ${pad(e.kind, 18)}  ${pad(eventFrom(e), 10)}  ${eventPreview(e)}`,
  );
  return `${lines.join('\n')}\ncursor: ${cursor}`;
}

/** Just the new lines, no cursor line — used by `brackish watch` which prints continuously. */
export function formatEventsStream(events: Event[]): string {
  return events
    .map(
      (e) =>
        `${pad(e.id, 5)}  ${shortDate(e.createdAt)}  ${pad(e.kind, 18)}  ${pad(eventFrom(e), 10)}  ${eventPreview(e)}`,
    )
    .join('\n');
}

export function formatDocuments(documents: Document[]): string {
  if (documents.length === 0) return '(no documents)';
  const lines = documents.map(
    (t) => `${pad(t.name, 24)}  ${shortDate(t.createdAt)}  ${t.createdBy}`,
  );
  return `${pad('NAME', 24)}  ${pad('CREATED', 21)}  BY\n${lines.join('\n')}`;
}

export function formatInbox(identity: string, entries: InboxEntry[]): string {
  if (entries.length === 0) return `(inbox empty for ${identity})`;
  const lines = entries.map(
    (e) =>
      `${pad(e.documentName, 24)}  ${pad(`${e.newCount} new`, 8)}  ${shortDate(e.lastEventAt)}  ${pad(e.lastFrom ?? '-', 10)}  ${trim(e.preview, 60)}`,
  );
  return `${entries.length} document${entries.length === 1 ? '' : 's'} with new events for ${identity}:\n${lines.join('\n')}`;
}

export function formatParties(parties: Party[]): string {
  if (parties.length === 0) return '(no parties)';
  const lines = parties.map(
    (p) =>
      `${pad(p.identity, 16)}  ${shortDate(p.createdAt)}  ${p.lastSeenAt ? shortDate(p.lastSeenAt) : '(never)'}`,
  );
  return `${pad('IDENTITY', 16)}  ${pad('CREATED', 21)}  LAST_SEEN\n${lines.join('\n')}`;
}

// --- artifact summaries (kind-aware) ---

export function formatEndpointSummaries(summaries: EndpointSummary[]): string {
  if (summaries.length === 0) return '(no endpoints)';
  const lines = summaries.map(
    (a) =>
      `${pad(a.method.toUpperCase(), 6)} ${pad(a.path, 28)}  ${pad(versionPair(a.currentVersion, a.latestProposedVersion), 10)}  ${pad(a.latestProposedBy ?? '—', 10)}  ${trim(a.summary ?? a.latestDelta ?? '', 60)}`,
  );
  return `${pad('METHOD', 6)} ${pad('PATH', 28)}  ${pad('CUR/PROP', 10)}  ${pad('LAST_BY', 10)}  NOTE\n${lines.join('\n')}`;
}

export function formatSchemaSummaries(summaries: SchemaSummary[]): string {
  if (summaries.length === 0) return '(no schemas)';
  const lines = summaries.map(
    (a) =>
      `${pad(a.name, 24)}  ${pad(versionPair(a.currentVersion, a.latestProposedVersion), 10)}  ${pad(a.latestProposedBy ?? '—', 10)}  ${trim(a.latestDelta ?? '', 60)}`,
  );
  return `${pad('NAME', 24)}  ${pad('CUR/PROP', 10)}  ${pad('LAST_BY', 10)}  DELTA\n${lines.join('\n')}`;
}

function versionPair(current: number | null, latestProposed: number | null): string {
  const c = current === null ? '—' : `v${current}`;
  const p = latestProposed === null ? '—' : `v${latestProposed}`;
  return `${c} / ${p}`;
}

export function describeOperation(v: OperationArtifact): string {
  const base = `${v.method.toUpperCase()} ${v.path} v${v.version} — ${v.status}, proposed by ${v.proposedBy} at ${shortDate(v.proposedAt)}`;
  return decorateStatus(base, v);
}

export function describeSchema(v: SchemaArtifact): string {
  const base = `${v.name} v${v.version} — ${v.status}, proposed by ${v.proposedBy} at ${shortDate(v.proposedAt)}`;
  return decorateStatus(base, v);
}

export function describeConvention(v: ConventionArtifact): string {
  const base = `convention v${v.version} — ${v.status}, proposed by ${v.proposedBy} at ${shortDate(v.proposedAt)}`;
  return decorateStatus(base, v);
}

function decorateStatus(
  base: string,
  v: OperationArtifact | SchemaArtifact | ConventionArtifact,
): string {
  switch (v.status) {
    case 'proposed':
      return base;
    case 'accepted':
      return `${base}; accepted by ${v.acceptedBy} at ${shortDate(v.acceptedAt)}`;
    case 'rejected':
      return `${base}; rejected by ${v.rejectedBy} at ${shortDate(v.rejectedAt)}: ${v.rejectionReason}`;
  }
}

function pad(s: string | number, width: number): string {
  const str = String(s);
  if (str.length >= width) return str;
  return str + ' '.repeat(width - str.length);
}

export function formatLintIssues(issues: LintIssue[]): string {
  if (issues.length === 0) return '(no issues)';
  return issues
    .map((i) => `${i.severity === 'error' ? 'error' : 'warn '}  ${i.field}: ${i.message}`)
    .join('\n');
}
