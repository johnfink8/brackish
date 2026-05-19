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
import { type Identity, IdentitySchema } from './models.js';
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

    // TCP path: bearer token (Authorization header preferred; ?token=… query param accepted as
    // a fallback so browsers visiting /ui/<doc> can authenticate from a URL).
    const authHeader = c.req.header('Authorization');
    const queryToken = c.req.query('token');
    let token: string | undefined;
    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.slice('Bearer '.length).trim();
    } else if (queryToken && queryToken.length > 0) {
      token = queryToken;
    }
    if (!token) {
      return c.json(
        {
          error:
            'Authorization: Bearer <token> required for TCP transport (or ?token=… query param for browser URLs)',
        },
        401,
      );
    }
    const identity = await store.getIdentityForToken(token);
    if (!identity) {
      return c.json({ error: 'invalid token' }, 401);
    }
    await store.touchPartySeen(identity);
    c.set('identity', identity);
    await next();
  };
}
