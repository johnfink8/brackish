// Compact text formatters for the agent-facing CLI output. JSON is the simple path
// (JSON.stringify of whatever the API returns); these helpers handle the text path,
// which we default to because it's denser in the agent's context window.

import type {
  ArtifactSummary,
  ArtifactVersion,
  Document,
  Event,
  InboxEntry,
  Party,
} from './models.js';

const trim = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** Strip subsecond precision for compactness; otherwise we burn 4 chars on ".XXXZ". */
const shortDate = (iso: string): string => iso.replace(/\.\d+Z$/, 'Z');

const eventPreview = (e: Event): string => {
  switch (e.kind) {
    case 'message':
      return trim(e.text, 80);
    case 'artifact_proposed':
      return `${e.artifactName}@${e.version} (${e.artifactKind})`;
    case 'artifact_accepted':
      return `${e.artifactName}@${e.version}`;
    case 'artifact_rejected':
      return `${e.artifactName}@${e.version}: ${trim(e.reason, 60)}`;
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

export function formatArtifactSummaries(summaries: ArtifactSummary[]): string {
  if (summaries.length === 0) return '(no artifacts)';
  const lines = summaries.map(
    (a) =>
      `${pad(a.name, 20)}  ${pad(a.kind, 12)}  ${pad(a.currentVersion ? `v${a.currentVersion}` : '—', 8)}  ${pad(a.latestProposedVersion ? `v${a.latestProposedVersion}` : '—', 10)}  ${pad(a.latestProposedBy ?? '—', 10)}  ${a.latestProposedAt ? shortDate(a.latestProposedAt) : '—'}`,
  );
  return `${pad('NAME', 20)}  ${pad('KIND', 12)}  ${pad('CURRENT', 8)}  ${pad('PROPOSED', 10)}  ${pad('BY', 10)}  AT\n${lines.join('\n')}`;
}

export function formatParties(parties: Party[]): string {
  if (parties.length === 0) return '(no parties)';
  const lines = parties.map(
    (p) =>
      `${pad(p.identity, 16)}  ${shortDate(p.createdAt)}  ${p.lastSeenAt ? shortDate(p.lastSeenAt) : '(never)'}`,
  );
  return `${pad('IDENTITY', 16)}  ${pad('CREATED', 21)}  LAST_SEEN\n${lines.join('\n')}`;
}

export function describeArtifactVersion(v: ArtifactVersion): string {
  const base = `${v.name}@${v.version} (${v.kind}) — ${v.status}, proposed by ${v.proposedBy} at ${shortDate(v.proposedAt)}`;
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
