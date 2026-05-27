// Shared helpers for the brackish CLI modules. Anything used by more than one command tree
// lives here so each per-command file stays small.

import { createSocket as createDgramSocket } from 'node:dgram';
import { stringify as yamlStringify } from 'yaml';
import { BrackishClient, ClientError, clientOptionsFromConfig } from '../client/client.js';
import { loadClientConfig } from '../io/config.js';
import type { LintIssue, LintResult } from '../lib/lint.js';
import type { DiffResponse } from '../lib/models.js';
import type { ParseResult } from '../lib/specfile.js';
import { formatLintIssues } from '../render/output.js';

// --- output helpers ---

export function emit(text: string): void {
  process.stdout.write(`${text}\n`);
}

export function emitJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Emit a tagged `show` result: metadata (label + headers) to stderr, spec body to stdout, so
 *  `brackish show <noun> <id> > file.yaml` captures only the spec. */
export function emitShow(rendered: { meta: string; body: string }): void {
  process.stderr.write(`${rendered.meta}\n`);
  if (rendered.body.length > 0) process.stdout.write(`${rendered.body}\n`);
}

/** After any command, remind the caller of moves they've made but not yet delivered (so the peer
 *  still can't see them). Phrased to reassure that delivering mid-turn is unnecessary — the nudge
 *  is "deliver eventually, at turn's end", not "deliver now" — so the proposer keeps batching a
 *  coherent turn. Wired once into withClient; best-effort, never derails the command, and silent
 *  when nothing is held (the normal state outside an active turn). */
async function remindHeld(client: BrackishClient): Promise<void> {
  let held: Array<{ documentName: string; held: number }> = [];
  try {
    held = await client.heldByDoc();
  } catch {
    return;
  }
  if (held.length === 0) return;
  const total = held.reduce((n, h) => n + h.held, 0);
  const where = held.map((h) => `${h.documentName} (${h.held})`).join(', ');
  const m = total === 1 ? 'move' : 'moves';
  process.stderr.write(
    `↪ ${total} held ${m} not yet delivered — in ${where}. The peer sees your turn only after \`brackish deliver <doc>\` (or \`nap\`/\`wait\`, which deliver for you). Finish your turn first; no need to deliver mid-thought.\n`,
  );
}

/** Thrown by errExit. The CLI's single top-level handler (cli.ts) writes the message + exits; an
 *  empty message means "exit silently" (output was already emitted, e.g. for --json). Throwing
 *  rather than process.exit keeps command logic composable and the CLI testable in-process. */
export class ExitError extends Error {
  constructor(
    readonly code: number,
    message = '',
  ) {
    super(message);
    this.name = 'ExitError';
  }
}

/** Abort the current command with an exit code (and optional message). Returns `never` — it throws,
 *  caught once at the top level. Pass an empty message to exit without printing anything more. */
export function errExit(code: number, message: string): never {
  throw new ExitError(code, message);
}

/** The most specific message from an error's `.cause` chain. undici's `fetch` rejects with a
 *  generic "fetch failed" and nests the actionable detail (TLS pin mismatch, ECONNREFUSED, …) in
 *  `.cause`; walk to the deepest non-empty cause so the user sees that, not "fetch failed". */
export function rootCauseMessage(err: unknown): string {
  let current: unknown = err;
  let message = current instanceof Error ? current.message : String(current);
  const seen = new Set<unknown>();
  while (current instanceof Error && current.cause !== undefined && !seen.has(current.cause)) {
    seen.add(current.cause);
    current = current.cause;
    const m = current instanceof Error ? current.message : String(current);
    if (m) message = m;
  }
  return message;
}

// --- repeatable commander option accumulator ---

export function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

// --- timing ---

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Run a client call that may 404 with `artifact_not_found`, return null on that
 *  specific failure mode, rethrow anything else. Used by `show` to fetch the
 *  accepted + proposed versions in parallel without one's absence killing the
 *  call. */
export async function getOrNull<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ClientError && e.code === 'artifact_not_found') return null;
    throw e;
  }
}

// --- diff output ---

export function emitDiff(diff: DiffResponse, format: string): void {
  if (format === 'yaml') {
    process.stdout.write(yamlStringify(diff));
    return;
  }
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(diff, null, 2)}\n`);
    return;
  }
  process.stderr.write(`diff ${diff.fromVersion} → ${diff.toVersion}:\n`);
  process.stdout.write(`${JSON.stringify(diff.patch, null, 2)}\n`);
}

/** Unified-style line diff between the YAML rendering of two specs. */
export function emitRenderedDiff(from: unknown, to: unknown, fromV: number, toV: number): void {
  const a = yamlStringify(from).split('\n');
  const b = yamlStringify(to).split('\n');
  if (a[a.length - 1] === '') a.pop();
  if (b[b.length - 1] === '') b.pop();
  const m = a.length;
  const n = b.length;
  const dp = new Array<number>((m + 1) * (n + 1)).fill(0);
  const at = (i: number, j: number): number => dp[i * (n + 1) + j] ?? 0;
  const set = (i: number, j: number, v: number): void => {
    dp[i * (n + 1) + j] = v;
  };
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      set(i, j, a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1)));
    }
  }
  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      lines.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      lines.push(`- ${a[i++]}`);
    } else {
      lines.push(`+ ${b[j++]}`);
    }
  }
  while (i < m) lines.push(`- ${a[i++]}`);
  while (j < n) lines.push(`+ ${b[j++]}`);
  process.stderr.write(`diff v${fromV} → v${toV} (rendered):\n`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

// --- lint finalize ---

export type LintFinalizeOpts = { json?: boolean; strict?: boolean };

export async function finalizeLint(
  parsed: ParseResult,
  doLint: (data: unknown) => Promise<LintResult> | LintResult,
  opts: LintFinalizeOpts,
): Promise<void> {
  if (!parsed.ok) {
    if (opts.json) {
      emitJson({
        errors: [{ severity: 'error', field: '(file)', message: parsed.message }],
        warnings: [],
      });
    } else {
      process.stderr.write(`${parsed.message}\n`);
    }
    errExit(1, ''); // already emitted the error; just set the exit code
  }
  const result = await doLint(parsed.data);
  const effectiveErrors: LintIssue[] = opts.strict
    ? [...result.errors, ...result.warnings]
    : result.errors;
  const effectiveWarnings = opts.strict ? [] : result.warnings;
  if (opts.json) {
    emitJson({ errors: effectiveErrors, warnings: effectiveWarnings });
  } else {
    const all = [...result.errors, ...result.warnings];
    if (all.length === 0) emit('ok');
    else emit(formatLintIssues(all));
  }
  if (effectiveErrors.length > 0) errExit(1, '');
}

// --- client wrapper ---

export type LoadedClientCfg = { socketPath?: string; server?: string; identity: string };

export async function withClient(
  fn: (client: BrackishClient, cfg: LoadedClientCfg) => Promise<void>,
): Promise<void> {
  let client: BrackishClient | null = null;
  try {
    const cfg = loadClientConfig();
    client = new BrackishClient(clientOptionsFromConfig(cfg));
    await fn(client, {
      identity: cfg.identity,
      ...(cfg.socketPath !== undefined ? { socketPath: cfg.socketPath } : {}),
      ...(cfg.server !== undefined ? { server: cfg.server } : {}),
    });
    // After any successful command, nudge about undelivered moves (once, centrally). Best-effort.
    await remindHeld(client);
  } catch (err) {
    // A command that already decided its exit (errExit → ExitError) must pass through unchanged —
    // otherwise its code/message would be rewritten as a generic Error below.
    if (err instanceof ExitError) throw err;
    if (err instanceof ClientError) {
      const code = err.status >= 500 ? 2 : 1;
      const hint = recoveryHint(err.code);
      const head = `${err.code ?? `HTTP ${err.status}`}: ${err.message}`;
      const issuesBlock = err.issues.length > 0 ? `\n${formatLintIssues(err.issues)}` : '';
      const lines = [head, issuesBlock, hint ? `  → ${hint}` : ''].filter((s) => s.length > 0);
      errExit(code, lines.join('\n'));
    }
    errExit(2, rootCauseMessage(err));
  } finally {
    if (client) await client.close();
  }
}

/** The document to act on: the explicit name if given, else the only one. Mirrors `status` — zero is
 *  an error (nothing to do), several requires an explicit name. Shared by the lifecycle verbs
 *  (`--doc`) and the standalone `read`. */
export async function resolveDoc(
  client: BrackishClient,
  explicit: string | undefined,
): Promise<string> {
  if (explicit !== undefined) return explicit;
  const docs = await client.listDocuments();
  const only = docs.length === 1 ? docs[0] : undefined;
  if (only !== undefined) return only.name;
  if (docs.length === 0) errExit(2, 'no documents yet — create one with `brackish doc new <name>`');
  errExit(
    2,
    `several documents exist — pass the doc name (have: ${docs.map((x) => x.name).join(', ')})`,
  );
}

/** Map a ClientError code to a one-line recovery suggestion. Null = no useful hint
 *  (server's message is already actionable). The CLI is the surface Claude reads mid-task; an
 *  error without a "→ try this next" is a turn-burner. */
function recoveryHint(code: string | null): string | null {
  switch (code) {
    case 'version_in_flight':
      return 'read the in-flight version with `brackish show <noun> <id>`, then accept/reject — or override with `--expected-rev <N>` / `--force`';
    case 'version_mismatch':
      return 'state drifted from your --expected-rev; `brackish read <doc>` to reconcile, then retry with the actual latest';
    case 'cannot_accept_own':
      return 'this is your proposal; only the peer can accept it. To take it back yourself: `brackish withdraw <noun> <id>`';
    case 'cannot_reject_own':
      return 'this is your proposal; only the peer can reject it. To take it back yourself: `brackish withdraw <noun> <id>`';
    case 'cannot_withdraw_others':
      return 'only the proposer can withdraw; reject it with a reason instead';
    case 'artifact_not_pending':
      return 'this version is already accepted or rejected — no pending version to act on. Check with `brackish status <doc>` for what is actually awaiting you';
    case 'artifact_not_found':
      return '`brackish list endpoint` or `brackish list schema` to confirm the identity key';
    case 'document_not_found':
      return '`brackish documents` to list existing docs (alias `brackish docs`)';
    case 'document_exists':
      return 'a doc with that name already exists — reuse it (`brackish status <name>`) or pick a different name';
    case 'invite_invalid':
    case 'invite_redeemed':
    case 'invite_expired':
      return 'ask the inviter for a fresh `/brackish connect …` line';
    case 'spec_invalid':
      return 'the assembled doc does not validate as OpenAPI 3.1. If the cited field-paths are NOT the artifact you are touching, the doc is already invalid from other artifacts — run `brackish validate <doc>` to see every problem, then fix or retract them together with `brackish propose retraction` (one proposal can list several --endpoint/--schema/--convention targets; you cannot repair a wedged doc one artifact at a time)';
    default:
      return null;
  }
}

// --- stdin / interactive prompts ---

export function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      data += c;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

// --- identity sanitization (used by daemon ensureClientConfig + install post-message) ---

export function sanitizeIdentity(raw: string): string {
  const lowered = raw.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  const trimmed = lowered.replace(/^[^a-z]+/, '').slice(0, 64);
  return trimmed || 'host';
}

// --- network helpers (used by daemon `serve --invite` + bootstrap `invite`) ---

/**
 * Discover the local IPv4 the kernel would source from for outbound traffic.
 *
 * UDP `connect()` stores a peer address and triggers a route-table lookup that binds the
 * socket to a local address — no packet is sent. The destination is 192.0.2.1 (TEST-NET-1,
 * RFC 5737), IETF-reserved as unroutable.
 */
async function discoverOutboundIPv4(): Promise<string | null> {
  return new Promise((resolve) => {
    const sock = createDgramSocket('udp4');
    let done = false;
    const finish = (val: string | null): void => {
      if (done) return;
      done = true;
      try {
        sock.close();
      } catch {
        /* already closed */
      }
      resolve(val);
    };
    sock.once('error', () => finish(null));
    sock.connect(1, '192.0.2.1', () => {
      try {
        const addr = sock.address();
        finish(addr.address && addr.address !== '0.0.0.0' ? addr.address : null);
      } catch {
        finish(null);
      }
    });
  });
}

export async function inferReachableHost(
  boundHost: string,
): Promise<{ host: string; hint?: string }> {
  if (boundHost !== '0.0.0.0' && boundHost !== '::') return { host: boundHost };
  const outbound = await discoverOutboundIPv4();
  if (outbound !== null) return { host: outbound };
  return {
    host: boundHost,
    hint: "couldn't infer a reachable host; replace 0.0.0.0 with this machine's address",
  };
}
