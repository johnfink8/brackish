// Hono middleware that resolves the calling identity.
//
// Socket transport (peer-trust): trust the `X-Brackish-Identity` header verbatim. Filesystem perms
// on the socket gate access; whoever wrote a request through the socket is the trusted user.
// Identity is a self-declared label; we lazily create a `parties` row so the rest of the system
// has somewhere to track last-seen.
//
// TCP transport (bearer-token): require `Authorization: Bearer <token>`; look up the identity
// via the parties/party_tokens tables. Identity is unspoofable on this path.
//
// `/ui/*` is a narrow exception on loopback TCP: browser navigations to localhost don't carry
// Authorization headers, so requiring bearer there would make the local browser UI unusable.
// Loopback is the trust boundary — anyone who can connect to 127.0.0.1 is already a local user.
// Cross-machine browser UI is an explicit non-goal; ssh-forward to loopback, or use the CLI.

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

/** True if the remote address is on the local loopback (IPv4 127/8 or IPv6 ::1).
 *  Used to gate the `/ui/*` no-auth bypass: only requests sourced from the same host
 *  qualify, so cross-machine browser UI is not reachable without explicit bearer auth. */
export function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  // node:net normalizes ::ffff:127.0.0.1 for IPv4-mapped clients; handle both forms.
  const addr = remoteAddress.replace(/^::ffff:/, '');
  if (addr === '::1') return true;
  return addr.startsWith('127.');
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

    // TCP path. Browser-UI exception: /ui/* is public on loopback. The `/ui/<doc>`
    // handler inlines the spec/rationale/events into the rendered HTML, so the page
    // is self-contained — no follow-up API calls leave the browser, so no further
    // auth surface is exposed by this bypass.
    const path = new URL(c.req.url).pathname;
    if (path.startsWith('/ui') && isLoopbackAddress(c.env.incoming.socket.remoteAddress)) {
      await next();
      return;
    }

    // TCP path, bearer-only via Authorization header. The legacy `?token=` query-string
    // fallback was removed — query tokens leak via Referer, access logs, browser
    // history, and shared URLs.
    const authHeader = c.req.header('Authorization');
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length).trim()
      : undefined;
    const ip = c.env.incoming.socket.remoteAddress ?? 'unknown';
    const limiter = opts.failedAuthLimiter;
    const limiterKey = `auth:${ip}`;
    // The limiter throttles FAILED auths only — successful Bearer requests don't
    // consume a slot. If prior failures already filled the bucket, deny up front.
    if (limiter?.isExhausted(limiterKey)) {
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
    const identity = await store.getIdentityForToken(token);
    if (!identity) {
      return failAuth('invalid bearer', { error: 'invalid token' });
    }
    await store.touchPartySeen(identity);
    c.set('identity', identity);
    await next();
  };
}
