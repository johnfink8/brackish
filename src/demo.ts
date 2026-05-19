// Seed a sample negotiated OpenAPI document for the browser UI demo.
//
// The demo models a "Chatter API" — a hello-world realtime chat — being co-developed by two
// Claude identities, `alice` (frontend) and `bob` (backend). The flow exercises:
//   - convention re-negotiation (v1 bearer-only → v2 adds cookie auth for the HTML page)
//   - schema rejections + re-proposals (User snake_case rejected; Message field-as-string rejected)
//   - endpoint rejections (POST /messages: status code; GET /messages/stream: filter shape)
//   - multiple content types: application/json, application/octet-stream, text/event-stream,
//     text/html, plus a 101 Switching Protocols WS upgrade documented via x-brackish.protocol
//   - chat-message transcript interleaved with the artifact moves
//
// Use the socket transport: peer-trust lets us impersonate both identities from one process.

import { BrackishClient } from './client.js';
import type {
  ConventionSpec,
  DocumentName,
  Identity,
  JSONSchema,
  OperationSpec,
} from './models.js';

export type SeedOptions = {
  socketPath: string;
  documentName?: DocumentName;
  alice?: Identity;
  bob?: Identity;
  onStep?: (message: string) => void;
};

export async function seedChatterDemo(opts: SeedOptions): Promise<{ documentName: DocumentName }> {
  const docName = (opts.documentName ?? 'chatter-api') as DocumentName;
  const alice = (opts.alice ?? 'alice') as Identity;
  const bob = (opts.bob ?? 'bob') as Identity;
  const step = opts.onStep ?? ((_m: string) => {});

  const a = new BrackishClient({ socketPath: opts.socketPath, identity: alice });
  const b = new BrackishClient({ socketPath: opts.socketPath, identity: bob });

  try {
    step(`creating document ${docName}`);
    await a.createDocument(docName);

    // --- Convention v1 (bearer-only) ---
    step('convention v1 (bearer-only)');
    await a.proposeConvention(docName, conventionV1);
    await b.acceptConvention(docName);

    // --- Error schema (always v1, no drama) ---
    step('schema Error');
    await a.proposeSchema(docName, 'Error', errorSchema);
    await b.acceptSchema(docName, 'Error');

    // --- User schema: snake_case rejected, camelCase accepted ---
    step('schema User v1 (snake_case)');
    await a.proposeSchema(docName, 'User', userSchemaV1Snake);
    await a.sendMessage(
      docName,
      'propose: User has id, displayName, avatarUrl, created_at. Naming style chosen to mirror DB columns; happy to adjust.',
    );
    step('  rejected by bob (snake_case)');
    await b.rejectSchema(
      docName,
      'User',
      'use camelCase everywhere; consistency with the rest of the API is more important than mirroring DB columns',
    );
    await b.sendMessage(
      docName,
      "rejecting User v1 — let's stay camelCase end-to-end so the codegen output is uniform on the frontend side.",
    );
    step('schema User v2 (camelCase)');
    await a.proposeSchema(docName, 'User', userSchemaV2Camel);
    await b.acceptSchema(docName, 'User');

    // --- Message schema: from-as-string rejected, from-as-User-ref accepted ---
    step('schema Message v1 (from: string)');
    await a.proposeSchema(docName, 'Message', messageSchemaV1String);
    step('  rejected by bob (expand from)');
    await b.rejectSchema(
      docName,
      'Message',
      'expand `from` to an embedded User reference — saves the frontend a second fetch per message in the timeline',
    );
    step('schema Message v2 (from: $ref User)');
    await a.proposeSchema(docName, 'Message', messageSchemaV2Ref);
    await b.acceptSchema(docName, 'Message');

    // --- MessageCreate, Attachment, WsEvent — straight accepts ---
    step('schema MessageCreate');
    await a.proposeSchema(docName, 'MessageCreate', messageCreateSchema);
    await b.acceptSchema(docName, 'MessageCreate');

    step('schema Attachment');
    await a.proposeSchema(docName, 'Attachment', attachmentSchema);
    await b.acceptSchema(docName, 'Attachment');

    step('schema WsEvent (discriminated union)');
    await a.proposeSchema(docName, 'WsEvent', wsEventSchema);
    await b.acceptSchema(docName, 'WsEvent');

    // --- POST /users (no rejection — clean accept) ---
    step('endpoint POST /users');
    await a.proposeEndpoint(docName, 'post', '/users', postUsersOp);
    await b.acceptEndpoint(docName, 'post', '/users');

    step('endpoint GET /users/{id}');
    await a.proposeEndpoint(docName, 'get', '/users/{id}', getUsersIdOp);
    await b.acceptEndpoint(docName, 'get', '/users/{id}');

    // --- POST /messages: 200 OK rejected, 201 accepted ---
    step('endpoint POST /messages v1 (200 OK)');
    await a.proposeEndpoint(docName, 'post', '/messages', postMessagesOpV1);
    step('  rejected by bob (status code)');
    await b.rejectEndpoint(
      docName,
      'post',
      '/messages',
      "should be 201 Created for resource creation — 200 is for things that don't create a new resource",
    );
    step('endpoint POST /messages v2 (201 Created)');
    await a.proposeEndpoint(docName, 'post', '/messages', postMessagesOpV2);
    await b.acceptEndpoint(docName, 'post', '/messages');

    // --- GET /messages (history) ---
    step('endpoint GET /messages (history)');
    await a.proposeEndpoint(docName, 'get', '/messages', getMessagesOp);
    await b.acceptEndpoint(docName, 'get', '/messages');

    // --- GET /messages/stream: SSE vs long-poll debate; alice's SSE wins ---
    // v1 (alice: SSE) → bob rejects, counter-proposes v2 (long-poll JSON) → alice rejects bob's
    // counter → alice re-proposes v3 ≈ v1 → bob accepts. The frontend's domain knowledge
    // (EventSource ergonomics, Last-Event-ID resume, ordering) prevails.
    step('endpoint GET /messages/stream v1 (alice: SSE with since cursor)');
    await a.proposeEndpoint(docName, 'get', '/messages/stream', getMessagesStreamOpV1);
    await a.sendMessage(
      docName,
      'opening with SSE — one open connection, server pushes, EventSource handles reconnect with Last-Event-ID for us.',
    );
    step('  rejected by bob (counter-pitch: long-poll)');
    await b.rejectEndpoint(
      docName,
      'get',
      '/messages/stream',
      'SSE needs nginx/proxy buffering tuned off + we lose request-level idempotency. Counter-proposing a long-poll: client GETs, server holds the connection up to ~30s and returns Message[] when new ones arrive or empty on timeout. Simpler infra.',
    );
    await b.sendMessage(
      docName,
      'going to counter-propose v2 with the long-poll shape so we can compare side-by-side.',
    );
    step('endpoint GET /messages/stream v2 (bob: long-poll counter-proposal)');
    await b.proposeEndpoint(docName, 'get', '/messages/stream', getMessagesStreamOpV2BobCounter);
    step('  rejected by alice (back to SSE)');
    await a.rejectEndpoint(
      docName,
      'get',
      '/messages/stream',
      'long-poll loses per-message ordering guarantees across reconnects, has no built-in Last-Event-ID resume, and the per-cycle overhead is significant at chat-room scale. EventSource is one line of client code. The proxy-buffering thing is a one-time deploy-side config change.',
    );
    await a.sendMessage(
      docName,
      're-proposing SSE as v3 — same shape as v1 but with explicit Last-Event-ID language in the description so the resume semantics are unambiguous.',
    );
    step('endpoint GET /messages/stream v3 (alice: SSE again, clarified)');
    await a.proposeEndpoint(docName, 'get', '/messages/stream', getMessagesStreamOpV3);
    await b.acceptEndpoint(docName, 'get', '/messages/stream');
    await b.sendMessage(
      docName,
      "ok, you're right about ordering + reconnect. Will disable proxy_buffering on this path; noting in the deploy runbook.",
    );

    // --- POST /attachments (octet-stream upload) ---
    step('endpoint POST /attachments (application/octet-stream)');
    await a.proposeEndpoint(docName, 'post', '/attachments', postAttachmentsOp);
    await b.acceptEndpoint(docName, 'post', '/attachments');

    // --- GET /attachments/{id} (octet-stream download) ---
    step('endpoint GET /attachments/{id}');
    await a.proposeEndpoint(docName, 'get', '/attachments/{id}', getAttachmentsIdOp);
    await b.acceptEndpoint(docName, 'get', '/attachments/{id}');

    // --- GET /ws (websocket upgrade) ---
    step('endpoint GET /ws (WebSocket upgrade, x-brackish.protocol)');
    await a.proposeEndpoint(docName, 'get', '/ws', getWsOp);
    await b.acceptEndpoint(docName, 'get', '/ws');

    // --- GET / (HTML page) ---
    step('endpoint GET / (text/html)');
    await a.proposeEndpoint(docName, 'get', '/', getRootOp);
    await b.acceptEndpoint(docName, 'get', '/');

    // --- Convention v2: now we need cookie auth for the HTML page ---
    step('convention v2 (add cookie auth for the HTML page)');
    await a.sendMessage(
      docName,
      "the HTML page at GET / needs an auth method that browsers handle automatically — bearer tokens via header don't work for navigation. Adding a cookie session scheme.",
    );
    await a.proposeConvention(docName, conventionV2);
    await b.acceptConvention(docName);
    await b.sendMessage(
      docName,
      "cookie session sgtm; we'll set it on `POST /sessions` (out of scope for this round, will add later).",
    );

    step('done');
    return { documentName: docName };
  } finally {
    await a.close();
    await b.close();
  }
}

// --- spec bodies (kept separate for readability) ---

const conventionV1: ConventionSpec = {
  info: {
    title: 'Chatter API',
    version: '0.1.0',
    description:
      'Hello-world realtime chat: send messages, stream updates, upload attachments. Demo seed for brackish.',
  },
  servers: [
    { url: 'https://chatter.example.com', description: 'production' },
    { url: 'https://chatter-staging.example.com', description: 'staging' },
  ],
  securitySchemes: {
    bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
  },
};

const conventionV2: ConventionSpec = {
  ...conventionV1,
  info: { ...conventionV1.info, version: '0.2.0' },
  securitySchemes: {
    bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    cookieSession: { type: 'apiKey', in: 'cookie', name: 'chatter_session' },
  },
};

const errorSchema: JSONSchema = {
  type: 'object',
  description: 'Standard error envelope',
  properties: {
    code: { type: 'string', description: 'Stable machine-readable identifier' },
    message: { type: 'string' },
    details: { type: 'string' },
  },
  required: ['code', 'message'],
};

const userSchemaV1Snake: JSONSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    display_name: { type: 'string' },
    avatar_url: { type: 'string', format: 'uri' },
    created_at: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'display_name', 'created_at'],
};

const userSchemaV2Camel: JSONSchema = {
  type: 'object',
  description: 'A chat participant',
  properties: {
    id: { type: 'string' },
    displayName: { type: 'string' },
    avatarUrl: { type: 'string', format: 'uri' },
    createdAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'displayName', 'createdAt'],
};

const messageSchemaV1String: JSONSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    from: { type: 'string', description: 'User id' },
    text: { type: 'string' },
    sentAt: { type: 'string', format: 'date-time' },
    attachmentId: { type: 'string' },
  },
  required: ['id', 'from', 'text', 'sentAt'],
};

const messageSchemaV2Ref: JSONSchema = {
  type: 'object',
  description: 'A posted chat message',
  properties: {
    id: { type: 'string' },
    from: { $ref: '#/components/schemas/User' },
    text: { type: 'string' },
    sentAt: { type: 'string', format: 'date-time' },
    attachmentId: { type: 'string' },
  },
  required: ['id', 'from', 'text', 'sentAt'],
};

const messageCreateSchema: JSONSchema = {
  type: 'object',
  description: 'Body for POST /messages',
  properties: {
    text: { type: 'string', minLength: 1, maxLength: 4000 },
    attachmentId: { type: 'string' },
  },
  required: ['text'],
};

const attachmentSchema: JSONSchema = {
  type: 'object',
  description: 'An uploaded blob (image, file, etc.) referenced from a Message',
  properties: {
    id: { type: 'string' },
    mimeType: { type: 'string' },
    size: { type: 'integer' },
    url: { type: 'string', format: 'uri' },
  },
  required: ['id', 'mimeType', 'size', 'url'],
};

const wsEventSchema: JSONSchema = {
  description:
    'A frame on the WebSocket channel. Discriminated by `kind`. Server pushes frames to subscribed clients; clients can POST MessageCreate frames over the same connection.',
  oneOf: [
    {
      type: 'object',
      properties: {
        kind: { const: 'message' },
        message: { $ref: '#/components/schemas/Message' },
      },
      required: ['kind', 'message'],
    },
    {
      type: 'object',
      properties: {
        kind: { const: 'typing' },
        userId: { type: 'string' },
        isTyping: { type: 'boolean' },
      },
      required: ['kind', 'userId', 'isTyping'],
    },
    {
      type: 'object',
      properties: {
        kind: { const: 'presence' },
        userId: { type: 'string' },
        state: { type: 'string', enum: ['online', 'offline'] },
      },
      required: ['kind', 'userId', 'state'],
    },
  ],
};

const postUsersOp: OperationSpec = {
  summary: 'Register a user',
  description: 'Create a new chat participant. Returns the freshly-issued User row.',
  requestBody: {
    required: true,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            displayName: { type: 'string' },
            avatarUrl: { type: 'string', format: 'uri' },
          },
          required: ['displayName'],
        },
      },
    },
  },
  responses: {
    '201': {
      description: 'created',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } },
    },
    '409': {
      description: 'displayName already taken',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    },
  },
};

const getUsersIdOp: OperationSpec = {
  summary: 'Fetch a user by id',
  security: [{ bearer: [] }],
  parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
  responses: {
    '200': {
      description: 'ok',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } },
    },
    '404': {
      description: 'not found',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    },
  },
  'x-brackish': { timing: { p50: '15ms', p99: '80ms' } },
};

const postMessagesOpV1: OperationSpec = {
  summary: 'Post a message',
  security: [{ bearer: [] }],
  requestBody: {
    required: true,
    content: {
      'application/json': { schema: { $ref: '#/components/schemas/MessageCreate' } },
    },
  },
  responses: {
    '200': {
      description: 'ok',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Message' } } },
    },
  },
};

const postMessagesOpV2: OperationSpec = {
  summary: 'Post a message',
  description: 'Persist a message and broadcast it to subscribers via the WS channel.',
  security: [{ bearer: [] }],
  requestBody: {
    required: true,
    content: {
      'application/json': { schema: { $ref: '#/components/schemas/MessageCreate' } },
    },
  },
  responses: {
    '201': {
      description: 'created',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Message' } } },
    },
    '400': {
      description: 'validation failed',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    },
  },
  'x-brackish': {
    sideEffects: ['writes messages table', 'broadcasts WsEvent {kind:message}'],
    timing: { p50: '20ms', p99: '150ms' },
  },
};

const getMessagesOp: OperationSpec = {
  summary: 'Recent messages',
  description: 'Returns messages in reverse chronological order.',
  security: [{ bearer: [] }],
  parameters: [
    {
      name: 'limit',
      in: 'query',
      schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
    },
    { name: 'before', in: 'query', description: 'message id cursor', schema: { type: 'string' } },
  ],
  responses: {
    '200': {
      description: 'ok',
      content: {
        'application/json': {
          schema: { type: 'array', items: { $ref: '#/components/schemas/Message' } },
        },
      },
    },
  },
};

const getMessagesStreamOpV1: OperationSpec = {
  summary: 'Stream live messages (SSE)',
  description:
    'Server-Sent Events stream of new messages since the cursor. Each frame is `event: message`, `data: <JSON-encoded Message>`.',
  security: [{ bearer: [] }],
  parameters: [
    {
      name: 'since',
      in: 'query',
      description: 'message id cursor; only messages with id > since are streamed',
      schema: { type: 'string' },
    },
  ],
  responses: {
    '200': {
      description: 'event stream',
      content: {
        'text/event-stream': {
          schema: { type: 'string', description: 'each event.data is a JSON-encoded Message' },
        },
      },
    },
  },
};

const getMessagesStreamOpV2BobCounter: OperationSpec = {
  summary: 'Poll for new messages (long-poll)',
  description:
    'Long-poll alternative to SSE: server holds the connection up to `timeout` seconds and returns when new messages arrive, or returns an empty array on timeout. Client should immediately re-request with the latest `since` cursor.',
  security: [{ bearer: [] }],
  parameters: [
    {
      name: 'since',
      in: 'query',
      description: 'message id cursor',
      schema: { type: 'string' },
    },
    {
      name: 'timeout',
      in: 'query',
      description: 'max seconds to hold the connection (default 30, max 60)',
      schema: { type: 'integer', default: 30, maximum: 60 },
    },
  ],
  responses: {
    '200': {
      description: 'new messages since cursor (possibly empty)',
      content: {
        'application/json': {
          schema: { type: 'array', items: { $ref: '#/components/schemas/Message' } },
        },
      },
    },
  },
};

const getMessagesStreamOpV3: OperationSpec = {
  summary: 'Stream live messages (SSE)',
  description:
    "Server-Sent Events stream. Pass the `Last-Event-ID` request header (or `?since=` as a fallback) to resume from a cursor; `EventSource` does this automatically on reconnect, so resume after a dropped connection is free. Each frame has `event: message` and `data: <JSON-encoded Message>`.\n\nDeploy note: this path needs `proxy_buffering off` (nginx) or equivalent so the proxy doesn't hold frames.",
  security: [{ bearer: [] }],
  parameters: [
    {
      name: 'since',
      in: 'query',
      description: 'fallback cursor when Last-Event-ID header is unavailable',
      schema: { type: 'string' },
    },
  ],
  responses: {
    '200': {
      description: 'event stream',
      content: {
        'text/event-stream': {
          schema: { type: 'string', description: 'each event.data is a JSON-encoded Message' },
        },
      },
    },
  },
};

const postAttachmentsOp: OperationSpec = {
  summary: 'Upload a binary attachment',
  description:
    'Raw upload — body is the binary content. Use the `Content-Type` request header to declare the mime type of the upload (e.g. image/png). The server stores the blob and returns an Attachment row whose `mimeType` echoes the request header.',
  security: [{ bearer: [] }],
  requestBody: {
    required: true,
    content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
  },
  responses: {
    '201': {
      description: 'stored',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Attachment' } } },
    },
    '413': {
      description: 'payload too large (max 25 MiB)',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    },
  },
  'x-brackish': {
    sideEffects: ['writes to S3 (bucket: chatter-attachments)'],
    timing: { p50: '300ms', p99: '5s' },
  },
};

const getAttachmentsIdOp: OperationSpec = {
  summary: 'Download an attachment',
  description: 'Streams the raw blob. `Content-Type` mirrors the Attachment.mimeType from upload.',
  security: [{ bearer: [] }],
  parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
  responses: {
    '200': {
      description: 'ok',
      content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
    },
    '404': {
      description: 'not found',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    },
  },
};

const getWsOp: OperationSpec = {
  summary: 'WebSocket handshake',
  description:
    'Upgrade an HTTP connection to WebSocket. After upgrade, the server pushes JSON-encoded `WsEvent` frames; the client can post `MessageCreate` frames to send messages over the same socket.',
  security: [{ bearer: [] }],
  responses: {
    '101': { description: 'Switching Protocols' },
    '401': { description: 'missing/invalid token' },
  },
  'x-brackish': {
    protocol: 'websocket',
    frames: {
      serverToClient: '#/components/schemas/WsEvent',
      clientToServer: '#/components/schemas/MessageCreate',
    },
    sideEffects: ['subscribes the connection to room broadcasts'],
  },
};

const getRootOp: OperationSpec = {
  summary: 'Web client',
  description: 'The chat page itself. Auth is via the `chatter_session` cookie (see Convention).',
  security: [{ cookieSession: [] }],
  responses: {
    '200': {
      description: 'the chat page',
      content: { 'text/html': { schema: { type: 'string' } } },
    },
    '302': {
      description: 'redirect to /login if no session',
    },
  },
};
