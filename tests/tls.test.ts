import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rootCauseMessage } from '../src/cli/common.js';
import { BrackishClient, redeemInvite } from '../src/client/client.js';
import { type RunningServer, startServer } from '../src/daemon/server.js';
import { certFingerprint, normalizePin } from '../src/lib/tls.js';

// openssl is required to mint the test cert; skip the TLS-server tests where it isn't on PATH
// (the prod `tls gen` path degrades with a clear error in that case — see src/cli/tls.ts).
const hasOpenssl = spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0;

const ZERO_PIN = `sha256:${'0'.repeat(64)}`;

describe('normalizePin', () => {
  const hex = 'a'.repeat(64);

  it('canonicalizes the colon-separated uppercase (openssl/node) form', () => {
    const node = `${'AB:'.repeat(31)}AB`; // 32 octets, uppercase, colon-separated
    expect(normalizePin(node)).toBe(`sha256:${'ab'.repeat(32)}`);
  });

  it('accepts an optional sha256: prefix and is case-insensitive', () => {
    expect(normalizePin(`sha256:${hex.toUpperCase()}`)).toBe(`sha256:${hex}`);
    expect(normalizePin(hex)).toBe(`sha256:${hex}`);
  });

  it('rejects anything that is not a 256-bit hex digest', () => {
    expect(() => normalizePin('sha256:nothex')).toThrow(/invalid TLS pin/);
    expect(() => normalizePin('a'.repeat(63))).toThrow(/invalid TLS pin/);
    expect(() => normalizePin('')).toThrow(/invalid TLS pin/);
  });
});

describe('rootCauseMessage', () => {
  it('returns the deepest non-empty cause message (undici buries it under "fetch failed")', () => {
    const deep = new Error('TLS cert pin mismatch: …');
    const mid = new Error('', { cause: deep }); // empty intermediate — should be skipped
    const top = new Error('fetch failed', { cause: mid });
    expect(rootCauseMessage(top)).toBe('TLS cert pin mismatch: …');
  });

  it('falls back to the error message when there is no cause', () => {
    expect(rootCauseMessage(new Error('boom'))).toBe('boom');
  });

  it('handles non-Error inputs', () => {
    expect(rootCauseMessage('plain string')).toBe('plain string');
  });
});

describe('BrackishClient TLS option validation', () => {
  it('throws when an https:// server is given without a pin', () => {
    expect(
      () => new BrackishClient({ server: 'https://host:11442', token: 'x'.repeat(20) }),
    ).toThrow(/requires a --tls-pin/);
  });

  it('throws when a pin is given for an http:// server', () => {
    expect(
      () =>
        new BrackishClient({
          server: 'http://host:11442',
          token: 'x'.repeat(20),
          tlsPin: ZERO_PIN,
        }),
    ).toThrow(/not https/);
  });
});

describe.skipIf(!hasOpenssl)('TLS serving + cert pinning (end to end)', () => {
  let tmp: string;
  let certPath: string;
  let keyPath: string;
  let pin: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'brackish-tls-fixtures-'));
    certPath = join(tmp, 'cert.pem');
    keyPath = join(tmp, 'key.pem');
    const r = spawnSync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=brackish-test',
    ]);
    if (r.status !== 0) throw new Error(`openssl gen failed: ${r.stderr}`);
    pin = certFingerprint(readFileSync(certPath, 'utf8'));
  });

  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('certFingerprint matches `openssl x509 -fingerprint -sha256`', () => {
    const out = spawnSync(
      'openssl',
      ['x509', '-in', certPath, '-noout', '-fingerprint', '-sha256'],
      {
        encoding: 'utf8',
      },
    ).stdout;
    // e.g. "sha256 Fingerprint=AB:CD:..." → normalize the hex tail and compare.
    const tail = out.split('=')[1] ?? '';
    expect(normalizePin(tail)).toBe(pin);
  });

  describe('against a running TLS daemon', () => {
    let home: string;
    let server: RunningServer;
    let httpsUrl: string;
    const savedHome = process.env.BRACKISH_HOME;

    beforeEach(async () => {
      home = mkdtempSync(join(tmpdir(), 'brackish-tls-'));
      process.env.BRACKISH_HOME = home;
      server = await startServer({
        config: {
          socketPath: join(home, 'brackish.sock'),
          dataPath: join(home, 'brackish.db'),
          bind: '127.0.0.1:0',
          tlsCert: certPath,
          tlsKey: keyPath,
        },
      });
      if (!server.tcpAddress) throw new Error('expected TCP bind');
      expect(server.tcpScheme).toBe('https');
      expect(server.tlsFingerprint).toBe(pin);
      httpsUrl = `https://127.0.0.1:${server.tcpAddress.port}`;
    });

    afterEach(async () => {
      await server.close();
      if (savedHome !== undefined) process.env.BRACKISH_HOME = savedHome;
      else delete process.env.BRACKISH_HOME;
      rmSync(home, { recursive: true, force: true });
    });

    it('redeems + uses a token over https when the pin matches', async () => {
      const admin = new BrackishClient({ socketPath: server.socketPath, identity: 'admin' });
      try {
        const inv = await admin.createInvite('peer', 300);
        const persistent = await redeemInvite(httpsUrl, inv.inviteToken, { tlsPin: pin });
        expect(persistent.identity).toBe('peer');

        const peer = new BrackishClient({ server: httpsUrl, token: persistent.token, tlsPin: pin });
        try {
          const me = await peer.whoami();
          expect(me.identity).toBe('peer');
        } finally {
          await peer.close();
        }
      } finally {
        await admin.close();
      }
    });

    it('refuses the connection when the pin does not match, with a clear reason (no MITM)', async () => {
      const admin = new BrackishClient({ socketPath: server.socketPath, identity: 'admin' });
      try {
        const inv = await admin.createInvite('peer', 300);
        const err = await redeemInvite(httpsUrl, inv.inviteToken, { tlsPin: ZERO_PIN }).then(
          () => null,
          (e: unknown) => e,
        );
        expect(err).not.toBeNull();
        // undici surfaces the connector rejection as "fetch failed"; the pin-mismatch detail is in
        // .cause, which rootCauseMessage (and thus the CLI) must recover.
        expect(rootCauseMessage(err)).toMatch(/pin mismatch/i);
      } finally {
        await admin.close();
      }
    });
  });
});
