# Canonical patterns: WebSocket, SSE, x-brackish

Read this if your negotiation includes WebSocket handshakes, SSE streams, or anything with custom `x-brackish.*` metadata. The shapes here are conventions that the brackish ecosystem (visualize, codegen consumers, the next pair of agents reading the spec) recognizes.

## `x-brackish` extension fields

Brackish-specific metadata uses OpenAPI's `x-` extension hatch, **consolidated into one key per object** so it reads as a single metadata block (and doesn't pattern-match against HTTP headers).

```yaml
# On an Operation:
x-brackish:
  idempotent: true                              # declares intent (orthogonal to HTTP method)
  sideEffects:                                  # free-text notes on what state this mutates
    - "writes orders table"
    - "publishes order.created event"
  timing: { p50: 20ms, p99: 150ms, timeout: 2s }
  streaming: sse                                # for SSE/long-poll endpoints
  protocol: websocket                           # for WS handshake operations
  frames:                                       # WS frame catalog (when protocol=websocket)
    client_to_server: [ "..." ]
    server_to_client: [ "..." ]

# On a Convention:
x-brackish:
  naming: camelCase                             # JSON-key casing (camelCase | snake_case)
```

These are **OpenAPI Specification Extensions**, not HTTP headers — they live alongside `responses` and `security` on the Operation Object as vendor metadata. Validators that don't understand them ignore them; Swagger UI passes them through; brackish renders them in markdown + sidebar views.

**Use the canonical field names above** — don't invent variants (e.g. `sideEffect` singular, `idempotency`). The consolidation exists so we have one place that defines them.

## WebSocket handshake

Model the WS handshake as a `GET` operation with response code `101 Switching Protocols`. Put the frame catalog in `x-brackish.frames` as arrays of **`$ref` strings** pointing at component schemas that define each frame shape:

```yaml
# brackish endpoint propose <doc> GET /ws --file ws-handshake.yaml
summary: WebSocket handshake
responses:
  "101": { description: Switching Protocols }
  "401": { description: missing/invalid auth }
security:
  - bearer: []
x-brackish:
  protocol: websocket
  frames:
    client_to_server:
      - "#/components/schemas/ClientHello"
      - "#/components/schemas/ClientMessage"
    server_to_client:
      - "#/components/schemas/ServerEvent"
      - "#/components/schemas/ServerError"
```

Then propose each frame as its own schema (`ClientHello`, `ClientMessage`, `ServerEvent`, `ServerError`) so the catalog `$ref`s resolve.

## SSE stream

Model an SSE stream as a `GET` returning `text/event-stream`. Put the event-type catalog in `x-brackish.streaming` + `x-brackish.eventTypes`:

```yaml
summary: Live order updates
responses:
  "200":
    description: SSE stream; reconnect with Last-Event-ID
    content: { text/event-stream: {} }
security:
  - bearer: []
x-brackish:
  streaming: sse
  eventTypes:
    - "#/components/schemas/OrderCreatedEvent"
    - "#/components/schemas/OrderUpdatedEvent"
    - "#/components/schemas/OrderCancelledEvent"
```

Each event type is its own component schema, so consumers know what payload to expect per `event:` line.

## Frame catalogs are documentation, not codegen targets

Codegen tools won't auto-generate a dispatcher from `x-brackish.frames` or `x-brackish.eventTypes`. The catalog tells the consumer **which schemas to expect**; the runtime dispatcher (`case event.type === 'order.created'` block) is still hand-written.

That tradeoff is deliberate: WS/SSE messaging shapes are heterogeneous enough that no codegen tool consistently does the right thing, and the catalog at least makes the set of valid payloads machine-readable + reviewable.

## Server-Sent Events: operational notes

If you're the API server proposing SSE, include a deploy-note in the operation description or `x-brackish.sideEffects` about proxy buffering. Most reverse proxies (nginx, Cloudflare, ALB defaults) buffer responses, which silently breaks SSE — the consumer never receives events until the connection closes. Worth documenting once at the spec level so the operator knows.

## Connection-management operations (auxiliary)

If the WS/SSE handshake has connection-management auxiliaries (e.g. `POST /ws/keepalive`, `DELETE /sse/subscription/{id}`), propose those as ordinary endpoints. The handshake operation references the frame/event catalogs; the auxiliary operations are independent.
