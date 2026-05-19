import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { proposeBatchFromManifest } from '../src/batch.js';
import { BrackishClient } from '../src/client.js';
import { loadManifest } from '../src/manifest.js';
import { type RunningServer, startServer } from '../src/server.js';

function write(p: string, content: string): void {
  writeFileSync(p, content);
}

describe('loadManifest (pure)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'brackish-manifest-test-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('round-trips a valid manifest with relative file resolution', () => {
    const manifestPath = join(tmp, 'manifest.yaml');
    write(
      manifestPath,
      `
convention:
  file: convention.yaml
schemas:
  - name: User
    file: schemas/User.yaml
  - name: Order
    file: schemas/Order.yaml
    expected: new
endpoints:
  - method: POST
    path: /users
    file: endpoints/POST-users.yaml
`,
    );
    const r = loadManifest(manifestPath);
    if (!r.ok) throw new Error(`unexpected error: ${r.message}`);
    expect(r.manifest.convention?.file).toBe(join(tmp, 'convention.yaml'));
    expect(r.manifest.schemas.map((s) => s.name)).toEqual(['User', 'Order']);
    expect(r.manifest.schemas[0]?.file).toBe(join(tmp, 'schemas', 'User.yaml'));
    expect(r.manifest.endpoints[0]?.method).toBe('post');
    expect(r.manifest.endpoints[0]?.path).toBe('/users');
  });

  it('rejects an empty manifest', () => {
    const manifestPath = join(tmp, 'manifest.yaml');
    write(manifestPath, '{}');
    const r = loadManifest(manifestPath);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('empty');
  });

  it('rejects unknown top-level keys', () => {
    const manifestPath = join(tmp, 'manifest.yaml');
    write(manifestPath, 'mystery: 1\nschemas: []\n');
    const r = loadManifest(manifestPath);
    expect(r.ok).toBe(false);
  });

  it('reports a missing manifest file', () => {
    const r = loadManifest(join(tmp, 'nope.yaml'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('cannot read');
  });
});

describe('proposeBatchFromManifest (e2e via real client+server)', () => {
  let tmp: string;
  let manifestDir: string;
  let server: RunningServer;
  let host: BrackishClient;
  const savedHome = process.env.BRACKISH_HOME;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'brackish-batch-propose-test-'));
    manifestDir = join(tmp, 'project');
    process.env.BRACKISH_HOME = tmp;
    // Make project + nested dirs.
    rmSync(manifestDir, { recursive: true, force: true });
    writeFileSync(join(tmp, '.placeholder'), '');
    const fs = await import('node:fs');
    fs.mkdirSync(join(manifestDir, 'schemas'), { recursive: true });
    fs.mkdirSync(join(manifestDir, 'endpoints'), { recursive: true });

    server = await startServer({
      config: {
        socketPath: join(tmp, 'brackish.sock'),
        dataPath: join(tmp, 'brackish.db'),
      },
    });
    host = new BrackishClient({ socketPath: server.socketPath, identity: 'host' });
    await host.createDocument('d');
  });

  afterEach(async () => {
    await host.close();
    await server.close();
    if (savedHome !== undefined) process.env.BRACKISH_HOME = savedHome;
    else delete process.env.BRACKISH_HOME;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('proposes a convention + schemas + endpoints in order', async () => {
    write(join(manifestDir, 'convention.yaml'), `info: { title: Orders API, version: 1.0.0 }\n`);
    write(join(manifestDir, 'schemas', 'User.yaml'), `type: object\n`);
    write(join(manifestDir, 'schemas', 'Order.yaml'), `type: object\n`);
    write(
      join(manifestDir, 'endpoints', 'POST-users.yaml'),
      `responses: { '201': { description: Created } }\n`,
    );
    const manifestPath = join(manifestDir, 'manifest.yaml');
    write(
      manifestPath,
      `
convention:
  file: convention.yaml
schemas:
  - name: User
    file: schemas/User.yaml
  - name: Order
    file: schemas/Order.yaml
endpoints:
  - method: POST
    path: /users
    file: endpoints/POST-users.yaml
`,
    );

    const result = await proposeBatchFromManifest(host, 'd', manifestPath);
    expect(result.failed).toBeNull();
    expect(result.succeeded.map((s) => s.key.kind)).toEqual([
      'convention',
      'schema',
      'schema',
      'endpoint',
    ]);
    expect(result.succeeded.every((s) => s.version === 1)).toBe(true);
  });

  it('stops at a lint failure, leaving remaining items unproposed', async () => {
    // Endpoint with a path placeholder but no matching parameters entry → lint error.
    write(
      join(manifestDir, 'endpoints', 'GET-users-id.yaml'),
      `responses: { '200': { description: OK } }\n`,
    );
    write(join(manifestDir, 'schemas', 'User.yaml'), `type: object\n`);
    const manifestPath = join(manifestDir, 'manifest.yaml');
    write(
      manifestPath,
      `
schemas:
  - name: User
    file: schemas/User.yaml
endpoints:
  - method: GET
    path: /users/{id}
    file: endpoints/GET-users-id.yaml
`,
    );

    const result = await proposeBatchFromManifest(host, 'd', manifestPath);
    expect(result.failed?.stage).toBe('lint');
    if (result.failed && result.failed.stage === 'lint') {
      expect(result.failed.issues.length).toBeGreaterThan(0);
    }
    expect(result.succeeded.map((s) => s.key.kind)).toEqual(['schema']);
    expect(result.remaining).toEqual([]);
  });

  it('reports a parse error with a file path', async () => {
    write(join(manifestDir, 'schemas', 'broken.yaml'), `type: object\nbad: [: not valid yaml\n`);
    const manifestPath = join(manifestDir, 'manifest.yaml');
    write(manifestPath, `schemas:\n  - name: Broken\n    file: schemas/broken.yaml\n`);
    const result = await proposeBatchFromManifest(host, 'd', manifestPath);
    expect(result.failed?.stage).toBe('parse');
    if (result.failed && result.failed.stage === 'parse') {
      expect(result.failed.message).toContain('line');
    }
  });

  it('--lint-only does not propose anything', async () => {
    write(join(manifestDir, 'schemas', 'User.yaml'), `type: object\n`);
    const manifestPath = join(manifestDir, 'manifest.yaml');
    write(manifestPath, `schemas:\n  - name: User\n    file: schemas/User.yaml\n`);
    const result = await proposeBatchFromManifest(host, 'd', manifestPath, { lintOnly: true });
    expect(result.failed).toBeNull();
    expect(result.succeeded).toHaveLength(1);
    // Confirm nothing was actually proposed:
    await expect(host.getSchema('d', 'User', { proposed: true })).rejects.toThrow();
  });

  it('surfaces a manifest validation error before touching the network', async () => {
    const manifestPath = join(manifestDir, 'bad.yaml');
    write(manifestPath, `schemas:\n  - wrong: field\n`);
    const result = await proposeBatchFromManifest(host, 'd', manifestPath);
    expect(result.failed?.stage).toBe('manifest');
  });
});
