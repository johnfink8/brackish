import { describe, expect, it } from 'vitest';
import type { RationaleEntry } from '../src/daemon/store/index.js';
import type { Event } from '../src/lib/models.js';
import type { OpenAPIDocument } from '../src/lib/openapi.js';
import {
  renderHtml,
  renderJson,
  renderMarkdown,
  renderOpenAPIYaml,
  renderText,
} from '../src/render/render.js';

const fixtureDoc: OpenAPIDocument = {
  openapi: '3.1.0',
  info: { title: 'Orders API', version: '1.0.0', description: 'A sample API' },
  servers: [{ url: 'https://api.example.com', description: 'production' }],
  paths: {
    '/users': {
      post: {
        summary: 'Create a user',
        requestBody: {
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/UserCreate' } },
          },
        },
        responses: {
          '201': {
            description: 'created',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/User' } },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      User: {
        type: 'object',
        properties: { id: { type: 'string' }, email: { type: 'string' } },
        required: ['id', 'email'],
      },
      UserCreate: {
        type: 'object',
        properties: { email: { type: 'string' }, name: { type: 'string' } },
        required: ['email'],
      },
    },
  },
};

describe('renderText', () => {
  it('default (no --full) is ToC-only — small token footprint', () => {
    const out = renderText({ document: fixtureDoc });
    expect(out).toContain('# Orders API v1.0.0');
    expect(out).toContain('POST /users');
    expect(out).toContain('Create a user');
    expect(out).toContain('User');
    expect(out).toContain('UserCreate');
    // Crucially: no YAML spec body inline at the default verbosity.
    expect(out).not.toContain('$ref');
    expect(out).not.toContain('requestBody');
  });

  it('--full inlines operation + schema bodies', () => {
    const out = renderText({ document: fixtureDoc }, { full: true });
    expect(out).toContain('requestBody');
    expect(out).toContain('$ref');
  });

  it('reports "(no endpoints accepted yet)" for empty docs', () => {
    const doc: OpenAPIDocument = {
      openapi: '3.1.0',
      info: { title: 'Empty', version: '0.0.0' },
      paths: {},
    };
    expect(renderText({ document: doc })).toContain('(none accepted yet)');
  });
});

describe('renderOpenAPIYaml', () => {
  it('emits valid OpenAPI 3.1 YAML', () => {
    const out = renderOpenAPIYaml({ document: fixtureDoc });
    expect(out).toContain('openapi: 3.1.0');
    expect(out).toContain('title: Orders API');
    expect(out).toContain('/users:');
    expect(out).toContain('post:');
  });
});

describe('renderJson', () => {
  it('round-trips through JSON.parse', () => {
    const out = renderJson({ document: fixtureDoc });
    const parsed = JSON.parse(out) as OpenAPIDocument;
    expect(parsed.info.title).toBe('Orders API');
  });
});

describe('renderMarkdown', () => {
  const rationaleMap = {
    endpoints: new Map<string, RationaleEntry[]>([
      [
        'POST /users',
        [
          {
            version: 1,
            status: 'rejected' as const,
            proposedBy: 'host',
            proposedAt: '2026-05-19T10:00:00Z',
            rejectedBy: 'peer',
            rejectedAt: '2026-05-19T10:05:00Z',
            rejectionReason: 'needs 409 response',
            delta: null,
            spec: { summary: 'v1 spec', responses: { '200': { description: 'ok' } } },
          },
          {
            version: 2,
            status: 'accepted' as const,
            proposedBy: 'host',
            proposedAt: '2026-05-19T10:10:00Z',
            acceptedBy: 'peer',
            acceptedAt: '2026-05-19T10:15:00Z',
            delta: '+responses.409',
            spec: {
              summary: 'v2 spec',
              responses: { '200': { description: 'ok' }, '409': { description: 'conflict' } },
            },
          },
        ],
      ],
    ]),
    schemas: new Map<string, RationaleEntry[]>(),
    convention: [],
  };

  it('includes the rationale history under each element', () => {
    const out = renderMarkdown({ document: fixtureDoc, rationale: rationaleMap });
    expect(out).toContain('### `POST /users`');
    expect(out).toContain('Negotiation history');
    expect(out).toContain('rejected');
    expect(out).toContain('needs 409 response');
    expect(out).toContain('+responses.409');
    // Each version body is rendered as a collapsible YAML block.
    expect(out).toContain('v1 content');
    expect(out).toContain('v2 content');
    expect(out).toContain('summary: v1 spec');
    expect(out).toContain('summary: v2 spec');
  });

  it('renders message events as a discussion transcript when present', () => {
    const events = [
      {
        id: 5,
        documentName: 'orders',
        createdAt: '2026-05-19T10:01:00Z',
        kind: 'message' as const,
        from: 'host',
        text: "I'm thinking POST /users with email+name",
      },
    ];
    const out = renderMarkdown({ document: fixtureDoc, rationale: rationaleMap, events });
    expect(out).toContain('Discussion transcript');
    expect(out).toContain('email+name');
  });
});

describe('renderHtml', () => {
  it('embeds the spec JSON and loads Swagger UI from unpkg', () => {
    const html = renderHtml({ document: fixtureDoc }, { documentName: 'orders-api' });
    expect(html).toContain('unpkg.com/swagger-ui-dist');
    expect(html).toContain('SwaggerUIBundle');
    expect(html).toContain('"openapi":"3.1.0"');
    expect(html).toContain('orders-api');
  });

  it('renders the rationale sidebar with version entries', () => {
    const rationale = {
      endpoints: new Map<string, RationaleEntry[]>([
        [
          'POST /users',
          [
            {
              version: 1,
              status: 'accepted' as const,
              proposedBy: 'host',
              proposedAt: '2026-05-19T10:00:00Z',
              acceptedBy: 'peer',
              acceptedAt: '2026-05-19T10:05:00Z',
              delta: null,
              spec: { summary: 'create a user', responses: { '201': { description: 'created' } } },
            },
          ],
        ],
      ]),
      schemas: new Map<string, RationaleEntry[]>(),
      convention: [],
    };
    const html = renderHtml({ document: fixtureDoc, rationale }, { documentName: 'orders-api' });
    expect(html).toContain('rationale-content');
    expect(html).toContain('POST /users');
    expect(html).toContain('host');
    expect(html).toContain('peer');
    // The sidebar surfaces the proposed/rejected content as collapsible YAML blocks.
    // The text "show v<N> content" is built at runtime in the browser; check the
    // ingredients: the specYaml string (one line of the inlined YAML) and the
    // collapsible markup template.
    expect(html).toContain('summary: create a user');
    expect(html).toContain('details class="spec"');
  });

  it('escapes HTML-special characters in the document name', () => {
    const html = renderHtml({ document: fixtureDoc }, { documentName: 'evil<script>' });
    expect(html).not.toContain('evil<script>');
    expect(html).toContain('evil&lt;script&gt;');
  });

  // Targeted red test for the XSS via script-tag breakout: when peer-supplied text is
  // inlined into a <script> block via JSON.stringify, `</script>` inside the string
  // closes the script element prematurely and anything after it becomes parseable HTML.
  // The legitimate HTML emits exactly two </script> closers (Swagger UI loader + the
  // bootstrap script). Any third closer means a peer string broke out.
  it('peer-supplied message text cannot break out of the bootstrap <script> tag', () => {
    const events: Event[] = [
      {
        id: 1,
        documentName: 'orders',
        createdAt: '2026-05-19T10:00:00Z',
        kind: 'message',
        from: 'host',
        text: '</script><script>window.__pwned=true</script>',
      },
    ];
    const html = renderHtml({ document: fixtureDoc, events }, { documentName: 'orders-api' });
    const closers = (html.match(/<\/script>/g) ?? []).length;
    expect(closers).toBe(2);
  });

  it('peer-supplied schema description cannot break out of the bootstrap <script> tag', () => {
    const doc: OpenAPIDocument = {
      openapi: '3.1.0',
      info: { title: 'x', version: '0', description: '</script><script>alert(1)</script>' },
      paths: {},
    };
    const html = renderHtml({ document: doc }, { documentName: 'orders-api' });
    const closers = (html.match(/<\/script>/g) ?? []).length;
    expect(closers).toBe(2);
  });
});
