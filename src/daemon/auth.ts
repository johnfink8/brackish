// Hono middleware that resolves the calling identity.
//
// Socket transport (peer-trust): trust the `X-Brackish-Identity` header verbatim. Filesystem perms
// on the socket gate access; whoever wrote a request through the socket is the trusted user.
// Identity is a self-declared label; we lazily create a `parties` row so the rest of the system
// has somewhere to track last-seen.
//
// TCP transport (bearer-token): require `Authorization: Bearer <token>`; look up the identity
// via the parties/party_tokens tables. Identity is unspoofable on this path.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context, MiddlewareHandler } from 'hono';
import { type Identity, IdentitySchema } from '../lib/models.js';
import type { RateLimiter } from './limiter.js';
import type { Store } from './store/index.js';

export type Transport = 'sock' | 'tcp';

export type AppVariables = {
  identity: Identity;
  transport: Transport;
};

// @hono/node-server exposes Node's raw req/res via c.env.
export type AppBindings = {
  incoming: IncomingMessage;
  outgoing: ServerResponse;
};

export type AppContext = Context<{ Variables: AppVariables; Bindings: AppBindings }>;

/** Minimal surface of node:net Socket that `detectTransport` actually uses.
 *  Narrow on purpose so tests don't have to fake a whole IncomingMessage. */
export type SocketLike = {
  address(): { port: number } | Record<string, unknown> | null;
};

/** Tell whether the connection came in via Unix-domain socket or TCP. */
export function detectTransport(socket: SocketLike): Transport {
  const addr = socket.address();
  if (addr && typeof addr === 'object' && 'port' in addr) return 'tcp';
  return 'sock';
}

const HEADER_IDENTITY = 'X-Brackish-Identity';

/**
 * Build the auth middleware. The middleware sets `identity` and `transport` on the Hono context
 * so downstream handlers can read them with c.get('identity') / c.get('transport').
 */
export function makeAuthMiddleware(
  store: Store,
  opts: { failedAuthLimiter?: RateLimiter } = {},
): MiddlewareHandler<{ Variables: AppVariables; Bindings: AppBindings }> {
  return async (c, next) => {
    const transport = detectTransport(c.env.incoming.socket);
    c.set('transport', transport);

    if (transport === 'sock') {
      const raw = c.req.header(HEADER_IDENTITY);
      if (!raw) {
        return c.json({ error: `${HEADER_IDENTITY} header required for socket transport` }, 401);
      }
      const parsed = IdentitySchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: `invalid identity: ${parsed.error.issues[0]?.message}` }, 401);
      }
      await store.ensureParty(parsed.data);
      await store.touchPartySeen(parsed.data);
      c.set('identity', parsed.data);
      await next();
      return;
    }

    // TCP path: bearer-only via Authorization header. The legacy `?token=` query-string
    // fallback was removed in 0.6.0 — query tokens leak via Referer, access logs, browser
    // history, and shared URLs. Browser UI uses single-use OTT + HttpOnly cookie instead
    // (POST /ui-sessions → GET /ui-login → brackish_ui cookie).
    const authHeader = c.req.header('Authorization');
    const cookieToken = readBrackishUiCookie(c.req.header('Cookie'));
    let token: string | undefined;
    let isCookie = false;
    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.slice('Bearer '.length).trim();
    } else if (cookieToken) {
      token = cookieToken;
      isCookie = true;
    }
    const ip = c.env.incoming.socket.remoteAddress ?? 'unknown';
    const limiter = opts.failedAuthLimiter;
    const limiterKey = `auth:${ip}`;
    // The limiter throttles FAILED auths only — successful Bearer requests don't
    // consume a slot. If prior failures already filled the bucket, deny up front.
    if (limiter && limiter.isExhausted(limiterKey)) {
      const retry = limiter.retryAfterSeconds(limiterKey);
      c.header('Retry-After', String(retry));
      console.warn(`[brackish] rate-limited TCP auth from ${ip}`);
      return c.json({ error: 'too many requests', code: 'rate_limited' }, 429);
    }
    const failAuth = (msg: string, errBody: object): Response => {
      if (limiter) limiter.tryConsume(limiterKey);
      console.warn(`[brackish] ${msg} from ${ip}`);
      return c.json(errBody, 401);
    };
    if (!token) {
      return failAuth('missing bearer', {
        error: 'Authorization: Bearer <token> required for TCP transport',
      });
    }
    const identity = isCookie
      ? await store.getIdentityForUiSession(token)
      : await store.getIdentityForToken(token);
    if (!identity) {
      return failAuth('invalid bearer', { error: 'invalid token' });
    }
    await store.touchPartySeen(identity);
    c.set('identity', identity);
    await next();
  };
}

/** Extract the `brackish_ui` cookie value from a Cookie header. Browser-set cookies are
 *  the ONLY UI-auth path post-0.6.0 (replacing the removed `?token=` query fallback). */
function readBrackishUiCookie(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const piece of header.split(';')) {
    const [k, ...rest] = piece.trim().split('=');
    if (k === 'brackish_ui' && rest.length > 0) {
      const v = rest.join('=').trim();
      return v.length > 0 ? v : undefined;
    }
  }
  return undefined;
}
