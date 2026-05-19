// Typed HTTP client for the brackish wire protocol. One transport-aware request function
// underneath; typed methods on top.
//
// Socket mode: undici Agent with a unix-socket connect option; sends X-Brackish-Identity.
// TCP mode:    plain fetch; sends Authorization: Bearer <token>.

import { Agent, type Response as UndiciResponse, fetch as undiciFetch } from 'undici';
import type { z } from 'zod';
import {
  type ConnectResponse,
  ConnectResponseSchema,
  type Document,
  type DocumentName,
  DocumentSchema,
  type EventListResponse,
  EventListResponseSchema,
  type Identity,
  type InboxResponse,
  InboxResponseSchema,
  type InviteCreatedResponse,
  InviteCreatedResponseSchema,
  type PartiesResponse,
  PartiesResponseSchema,
  SendMessageResponseSchema,
  type WhoamiResponse,
  WhoamiResponseSchema,
} from './models.js';

export class ClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'ClientError';
  }
}

type RequestFn = (
  path: string,
  init?: { method?: string; body?: unknown; query?: Record<string, string | number | undefined> },
) => Promise<UndiciResponse>;

/** Discriminated union: socket-trust mode needs an identity; TCP mode needs a server+token. */
export type BrackishClientOptions =
  | { socketPath: string; identity: Identity }
  | { server: string; token: string };

export class BrackishClient {
  private readonly request: RequestFn;
  private readonly cleanup: (() => Promise<void>) | null;

  constructor(opts: BrackishClientOptions) {
    if ('socketPath' in opts) {
      const dispatcher = new Agent({ connect: { socketPath: opts.socketPath } });
      const identity = opts.identity;
      this.request = (path, init) =>
        undiciFetch(buildUrl('http://localhost', path, init?.query), {
          method: init?.method ?? 'GET',
          headers: jsonHeaders({ 'X-Brackish-Identity': identity }, init?.body),
          dispatcher,
          ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        });
      this.cleanup = () => dispatcher.close();
    } else {
      const base = opts.server.replace(/\/$/, '');
      const token = opts.token;
      this.request = (path, init) =>
        undiciFetch(buildUrl(base, path, init?.query), {
          method: init?.method ?? 'GET',
          headers: jsonHeaders({ Authorization: `Bearer ${token}` }, init?.body),
          ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        });
      this.cleanup = null;
    }
  }

  async close(): Promise<void> {
    if (this.cleanup) await this.cleanup();
  }

  // --- public + identity ---

  async healthz(): Promise<{ ok: boolean; version: string }> {
    const res = await this.request('/healthz');
    return unwrapJson(res) as Promise<{ ok: boolean; version: string }>;
  }

  whoami(): Promise<WhoamiResponse> {
    return this.fetchAndParse('/whoami', WhoamiResponseSchema);
  }

  // --- documents ---

  listDocuments(): Promise<Document[]> {
    return this.fetchAndParseField('/documents', 'documents', DocumentSchema.array());
  }

  createDocument(name: DocumentName): Promise<Document> {
    return this.fetchAndParse('/documents', DocumentSchema, { method: 'POST', body: { name } });
  }

  getDocument(name: DocumentName): Promise<Document> {
    return this.fetchAndParse(`/documents/${encodeURIComponent(name)}`, DocumentSchema);
  }

  // --- messages, events, wait, inbox ---

  async sendMessage(
    document: DocumentName,
    text: string,
  ): Promise<EventListResponse['events'][number]> {
    const parsed = await this.fetchAndParse(
      `/documents/${encodeURIComponent(document)}/messages`,
      SendMessageResponseSchema,
      { method: 'POST', body: { text } },
    );
    return parsed.event;
  }

  listEvents(
    document: DocumentName,
    opts: { since?: number; limit?: number } = {},
  ): Promise<EventListResponse> {
    return this.fetchAndParse(
      `/documents/${encodeURIComponent(document)}/events`,
      EventListResponseSchema,
      { query: { since: opts.since, limit: opts.limit } },
    );
  }

  wait(
    document: DocumentName,
    opts: { since?: number; timeoutSeconds?: number } = {},
  ): Promise<EventListResponse> {
    return this.fetchAndParse(
      `/documents/${encodeURIComponent(document)}/wait`,
      EventListResponseSchema,
      { query: { since: opts.since, timeout: opts.timeoutSeconds } },
    );
  }

  inbox(): Promise<InboxResponse> {
    return this.fetchAndParse('/inbox', InboxResponseSchema);
  }

  // --- parties, invites, connect ---

  createInvite(identity: Identity, ttlSeconds: number): Promise<InviteCreatedResponse> {
    return this.fetchAndParse('/invites', InviteCreatedResponseSchema, {
      method: 'POST',
      body: { identity, ttlSeconds },
    });
  }

  /** /connect doesn't require auth, but it's still exposed here for convenience when the caller
   *  is already authenticated. The standalone `redeemInvite(server, inviteToken)` helper is
   *  what bootstrap code uses, because at that point you don't yet have a persistent token. */
  connect(inviteToken: string): Promise<ConnectResponse> {
    return this.fetchAndParse('/connect', ConnectResponseSchema, {
      method: 'POST',
      body: { inviteToken },
    });
  }

  listParties(): Promise<PartiesResponse> {
    return this.fetchAndParse('/parties', PartiesResponseSchema);
  }

  async revokeParty(identity: Identity): Promise<void> {
    const res = await this.request(`/parties/${encodeURIComponent(identity)}`, {
      method: 'DELETE',
    });
    await okJson(res);
  }

  // --- internals ---

  private async fetchAndParse<T>(
    path: string,
    schema: z.ZodType<T>,
    init?: Parameters<RequestFn>[1],
  ): Promise<T> {
    const res = await this.request(path, init);
    const body = await okJson(res);
    return schema.parse(body);
  }

  private async fetchAndParseField<T>(
    path: string,
    field: string,
    schema: z.ZodType<T>,
    init?: Parameters<RequestFn>[1],
  ): Promise<T> {
    const res = await this.request(path, init);
    const body = (await okJson(res)) as Record<string, unknown>;
    return schema.parse(body[field]);
  }
}

// --- helpers ---

function buildUrl(
  base: string,
  path: string,
  query?: Record<string, string | number | undefined>,
): string {
  if (!query) return `${base}${path}`;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${base}${path}?${qs}` : `${base}${path}`;
}

function jsonHeaders(extra: Record<string, string>, body: unknown): Record<string, string> {
  const h: Record<string, string> = { ...extra };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  return h;
}

async function okJson(res: UndiciResponse): Promise<unknown> {
  const body = await res.json();
  if (!res.ok) {
    const e = body as { error?: string; code?: string };
    throw new ClientError(res.status, e.code ?? null, e.error ?? `HTTP ${res.status}`);
  }
  return body;
}

async function unwrapJson(res: UndiciResponse): Promise<unknown> {
  return okJson(res);
}

/** Standalone bootstrap helper: trade an invite token for a persistent (identity, token) pair.
 *  Doesn't require an authenticated client because /connect is a public route. */
export async function redeemInvite(server: string, inviteToken: string): Promise<ConnectResponse> {
  const url = `${server.replace(/\/$/, '')}/connect`;
  const res = await undiciFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inviteToken }),
  });
  const body = await okJson(res);
  return ConnectResponseSchema.parse(body);
}

/** Adapter from ClientConfig (CLI-facing) to BrackishClientOptions (transport-discriminated). */
export function clientOptionsFromConfig(
  cfg: import('./config.js').ClientConfig,
): BrackishClientOptions {
  if (cfg.socketPath !== undefined) {
    return { socketPath: cfg.socketPath, identity: cfg.identity };
  }
  if (cfg.server !== undefined && cfg.token !== undefined) {
    return { server: cfg.server, token: cfg.token };
  }
  throw new Error(
    'client config has neither a socketPath nor a server+token pair; run `brackish init` first',
  );
}
