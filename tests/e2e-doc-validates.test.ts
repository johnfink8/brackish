// End-to-end: propose a realistic multi-artifact doc, accept everything, fetch the assembled
// OpenAPI document via the wire, and run the official meta-schema validator on it. Confirms
// that brackish's arbitrator promise — every doc it produces is valid OpenAPI 3.1 — holds for
// non-trivial doc shapes including cross-artifact $refs.
//
// Regression test for the missing-ref class of bug: a doc settles with an `$ref` pointing at
// a schema that was never accepted (proposed-then-rejected, or never proposed at all). Before
// 0.5.0 brackish could leave the doc in this state; now the server refuses to let either side
// reach it.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, type Response as UndiciResponse, fetch as undiciFetch } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type RunningServer, startServer } from '../src/daemon/server.js';
import { validateDocument } from '../src/lib/validate.js';

describe('end-to-end: doc-validates after settling', () => {
  let tmp: string;
  let server: RunningServer;
  let sockAgent: Agent;
  const savedHome = process.env.BRACKISH_HOME;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'brackish-e2e-'));
    process.env.BRACKISH_HOME = tmp;
    server = await startServer({
      config: {
        socketPath: join(tmp, 'brackish.sock'),
        dataPath: join(tmp, 'brackish.db'),
      },
    });
    sockAgent = new Agent({ connect: { socketPath: server.socketPath } });
  });

  afterEach(async () => {
    await server.close();
    await sockAgent.close();
    if (savedHome !== undefined) process.env.BRACKISH_HOME = savedHome;
    else delete process.env.BRACKISH_HOME;
    rmSync(tmp, { recursive: true, force: true });
  });

  const call = async (
    method: string,
    path: string,
    opts: { identity?: string; body?: unknown } = {},
  ): Promise<UndiciResponse> => {
    const headers: Record<string, string> = { 'X-Brackish-Identity': opts.identity ?? 'alice' };
    const init: Parameters<typeof undiciFetch>[1] = { method, headers, dispatcher: sockAgent };
    if (opts.body !== undefined) {
      init.body = JSON.stringify(opts.body);
      headers['Content-Type'] = 'application/json';
    }
    return undiciFetch(`http://localhost${path}`, init);
  };

  const ok = async (
    method: string,
    path: string,
    opts: { identity?: string; body?: unknown } = {},
  ) => {
    const res = await call(method, path, opts);
    if (res.status >= 400) {
      const body = await res.text();
      throw new Error(`${method} ${path} → ${res.status}: ${body}`);
    }
    return res;
  };

  it('proposes a realistic chat API, accepts everything, and the assembled doc validates', async () => {
    await ok('POST', '/documents', { body: { name: 'chat' } });

    // Alice proposes the whole API as a single atomic batch.
    const batchRes = await ok('POST', '/documents/chat/propose-batch', {
      body: {
        convention: {
          spec: {
            info: { title: 'Chat API', version: '1.0.0' },
            servers: [{ url: 'https://example.com/v1' }],
            securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
            security: [{ bearer: [] }],
          },
        },
        schemas: [
          // Cross-refs: Message → User; MessageList → Message. Reply → Message (mutual-ish).
          {
            name: 'User',
            spec: {
              type: 'object',
              required: ['id', 'name'],
              properties: { id: { type: 'string' }, name: { type: 'string' } },
            },
          },
          {
            name: 'Message',
            spec: {
              type: 'object',
              required: ['id', 'author', 'text'],
              properties: {
                id: { type: 'string' },
                author: { $ref: '#/components/schemas/User' },
                text: { type: 'string' },
                replyTo: { $ref: '#/components/schemas/Message' },
              },
            },
          },
          {
            name: 'MessageList',
            spec: {
              type: 'object',
              required: ['messages'],
              properties: {
                messages: { type: 'array', items: { $ref: '#/components/schemas/Message' } },
                nextCursor: { type: 'string', nullable: true },
              },
            },
          },
          {
            name: 'Error',
            spec: {
              type: 'object',
              required: ['code', 'message'],
              properties: { code: { type: 'string' }, message: { type: 'string' } },
            },
          },
        ],
        endpoints: [
          {
            method: 'get',
            path: '/users/{id}',
            spec: {
              parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
              responses: {
                '200': {
                  description: 'the user',
                  content: {
                    'application/json': { schema: { $ref: '#/components/schemas/User' } },
                  },
                },
                '404': {
                  description: 'no such user',
                  content: {
                    'application/json': { schema: { $ref: '#/components/schemas/Error' } },
                  },
                },
              },
            },
          },
          {
            method: 'get',
            path: '/messages',
            spec: {
              parameters: [{ name: 'since', in: 'query', schema: { type: 'string' } }],
              responses: {
                '200': {
                  description: 'message page',
                  content: {
                    'application/json': { schema: { $ref: '#/components/schemas/MessageList' } },
                  },
                },
              },
            },
          },
          {
            method: 'post',
            path: '/messages',
            spec: {
              requestBody: {
                required: true,
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      required: ['text'],
                      properties: { text: { type: 'string' } },
                    },
                  },
                },
              },
              responses: {
                '201': {
                  description: 'created',
                  content: {
                    'application/json': { schema: { $ref: '#/components/schemas/Message' } },
                  },
                },
              },
            },
          },
        ],
      },
      identity: 'alice',
    });
    expect(batchRes.status).toBe(201);

    // Bob accepts everything.
    await ok('POST', '/documents/chat/convention/accept', { identity: 'bob' });
    for (const name of ['User', 'Message', 'MessageList', 'Error']) {
      await ok('POST', `/documents/chat/schemas/${name}/accept`, { identity: 'bob' });
    }
    for (const id of ['GET%20%2Fusers%2F%7Bid%7D', 'GET%20%2Fmessages', 'POST%20%2Fmessages']) {
      await ok('POST', `/documents/chat/endpoints/${id}/accept`, { identity: 'bob' });
    }

    // Fetch the assembled doc from the wire — same path `brackish visualize` uses.
    const docRes = await ok('GET', '/documents/chat/openapi.json');
    const doc = (await docRes.json()) as Record<string, unknown>;

    // Now run the same validator the server uses on propose/accept. If brackish let any
    // invalid state slip through, this would catch it.
    const v = await validateDocument(doc);
    expect(v.errors).toEqual([]);
  });

  it('prevents accepting an artifact whose ref target was rejected', async () => {
    // Propose Message + MessageList (which references Message), reject Message, then try to
    // accept MessageList. With brackish as the arbiter, the accept must fail — otherwise the
    // assembled-accepted doc would have a dangling ref.
    await ok('POST', '/documents', { body: { name: 'd' } });
    await ok('POST', '/documents/d/schemas', {
      body: { name: 'Message', spec: { type: 'object' } },
    });
    await ok('POST', '/documents/d/schemas', {
      body: {
        name: 'MessageList',
        spec: {
          type: 'object',
          properties: {
            messages: { type: 'array', items: { $ref: '#/components/schemas/Message' } },
          },
        },
      },
    });
    await ok('POST', '/documents/d/schemas/Message/reject', {
      identity: 'peer',
      body: { reason: 'wrong shape' },
    });
    const accept = await call('POST', '/documents/d/schemas/MessageList/accept', {
      identity: 'peer',
    });
    expect(accept.status).toBe(400);
    const body = (await accept.json()) as { code: string };
    expect(body.code).toBe('spec_invalid');
  });

  it('blocks reaching an invalid doc state through the convention path too', async () => {
    // Half-completing a convention (info-only) is fine; the meta-schema only fires on
    // explicit shape violations. But proposing an http securityScheme without `scheme` —
    // a real bug that ships invalid docs — must be rejected.
    await ok('POST', '/documents', { body: { name: 'c' } });
    const res = await call('POST', '/documents/c/convention', {
      body: {
        spec: {
          info: { title: 'X', version: '1.0.0' },
          securitySchemes: { bearerAuth: { type: 'http' } },
        },
      },
    });
    expect(res.status).toBe(400);

    // The doc is empty (the propose was rejected), so the assembled doc is just an Untitled
    // stub. It should still validate (paths is empty, no refs).
    const docRes = await ok('GET', '/documents/c/openapi.json');
    const doc = (await docRes.json()) as Record<string, unknown>;
    const v = await validateDocument(doc);
    expect(v.errors).toEqual([]);
  });
});
