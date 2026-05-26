// End-to-end full journey, driven through the actual verb-first CLI program — built and parsed
// in-process (the idiomatic commander approach: `buildProgram().exitOverride().parseAsync(argv)`),
// against a live in-process daemon. Exercises the whole stack: argv parsing, verb→noun→capability
// dispatch, --doc resolution, target resolution, the guards, and the client/server protocol.
// This is the grammar's regression guard: a mis-registered verb, a broken option, or a bad exit
// code fails here.
//
// errExit throws ExitError (not process.exit), so a failing command is catchable here; commander's
// own failures throw CommanderError under exitOverride. Output is captured by spying the process
// streams (emit/emitShow write there directly, as does commander). Both identities talk over the
// socket (peer-trust via BRACKISH_IDENTITY); the TCP/invite path + member admin stay client-level.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExitError } from '../src/cli/common.js';
import { buildProgram } from '../src/cli.js';
import { BrackishClient } from '../src/client/client.js';
import { type RunningServer, startServer } from '../src/daemon/server.js';

describe('happy-path: verb-first CLI journey (in-process) against a live daemon', () => {
  let tmp: string;
  let socketPath: string;
  let server: RunningServer;
  const saved = {
    home: process.env.BRACKISH_HOME,
    sock: process.env.BRACKISH_SOCKET,
    id: process.env.BRACKISH_IDENTITY,
  };

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'brackish-happy-'));
    socketPath = join(tmp, 'brackish.sock');
    server = await startServer({ config: { socketPath, dataPath: join(tmp, 'brackish.db') } });
    process.env.BRACKISH_HOME = tmp;
    process.env.BRACKISH_SOCKET = socketPath;
  });

  afterEach(async () => {
    await server.close();
    for (const [k, v] of [
      ['BRACKISH_HOME', saved.home],
      ['BRACKISH_SOCKET', saved.sock],
      ['BRACKISH_IDENTITY', saved.id],
    ] as const) {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Run one CLI command in-process as `identity`. Captures stdout+stderr (+ any error message) and
   *  the exit code. A fresh program per call avoids commander re-parse state. */
  const cli = async (identity: string, args: string[]): Promise<{ out: string; code: number }> => {
    process.env.BRACKISH_IDENTITY = identity;
    // Capture at call-time into our own array — mockRestore() clears mock.calls, so reading those
    // afterwards would come back empty.
    const chunks: string[] = [];
    const sink = (c: unknown): boolean => {
      chunks.push(String(c));
      return true;
    };
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(sink);
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(sink);
    let code = 0;
    try {
      await buildProgram()
        .exitOverride()
        .parseAsync(['node', 'brackish', ...args]);
    } catch (err) {
      if (err instanceof ExitError) {
        code = err.code;
        chunks.push(err.message);
      } else if (err instanceof CommanderError) {
        code = err.exitCode;
        chunks.push(err.message);
      } else {
        outSpy.mockRestore();
        errSpy.mockRestore();
        throw err;
      }
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
    }
    return { out: chunks.join(''), code };
  };

  /** Write a spec object to a temp file and return its path (for `propose --file`). */
  const spec = (name: string, obj: unknown): string => {
    const p = join(tmp, name);
    writeFileSync(p, JSON.stringify(obj));
    return p;
  };

  it('journey: propose/accept/reject/withdraw/show/diff/list + batch + retraction, --doc-scoped', async () => {
    // ===== doc =====
    expect((await cli('alice', ['doc', 'new', 'chat-api'])).code).toBe(0);

    // ===== convention: propose (alice) → accept (bob, the peer) =====
    const conv = spec('conv.json', {
      info: { title: 'Chat API', version: '1.0.0' },
      servers: [{ url: 'https://api.example.com' }],
    });
    expect(
      (
        await cli('alice', [
          'propose',
          'convention',
          '--doc',
          'chat-api',
          '--file',
          conv,
          '--expected-new',
        ])
      ).code,
    ).toBe(0);
    const acceptConv = await cli('bob', ['accept', 'convention', '--doc', 'chat-api']);
    expect(acceptConv.code).toBe(0);
    expect(acceptConv.out).toContain('accepted');

    // ===== schema: User accepted; Message rejected v1 → counter v2 → accepted =====
    const user = spec('user.json', {
      type: 'object',
      properties: { id: { type: 'string' }, name: { type: 'string' } },
      required: ['id'],
    });
    expect(
      (
        await cli('alice', [
          'propose',
          'schema',
          'User',
          '--doc',
          'chat-api',
          '--file',
          user,
          '--expected-new',
        ])
      ).code,
    ).toBe(0);
    expect((await cli('bob', ['accept', 'schema', 'User', '--doc', 'chat-api'])).code).toBe(0);

    const msgV1 = spec('msg1.json', {
      type: 'object',
      properties: { id: { type: 'string' }, body: { type: 'string' } },
      required: ['id', 'body'],
    });
    expect(
      (
        await cli('alice', [
          'propose',
          'schema',
          'Message',
          '--doc',
          'chat-api',
          '--file',
          msgV1,
          '--expected-new',
        ])
      ).code,
    ).toBe(0);

    // reject requires a reason → without --rationale it's a clean exit 2
    const noReason = await cli('bob', ['reject', 'schema', 'Message', '--doc', 'chat-api']);
    expect(noReason.code).toBe(2);
    expect(noReason.out).toContain('reason is required');
    expect(
      (
        await cli('bob', [
          'reject',
          'schema',
          'Message',
          '--doc',
          'chat-api',
          '--rationale',
          'needs created_at',
        ])
      ).code,
    ).toBe(0);

    const msgV2 = spec('msg2.json', {
      type: 'object',
      properties: {
        id: { type: 'string' },
        body: { type: 'string' },
        created_at: { type: 'string' },
      },
      required: ['id', 'body', 'created_at'],
    });
    expect(
      (
        await cli('alice', [
          'propose',
          'schema',
          'Message',
          '--doc',
          'chat-api',
          '--file',
          msgV2,
          '--expected-rev',
          '1',
        ])
      ).code,
    ).toBe(0);
    expect(
      (
        await cli('bob', [
          'accept',
          'schema',
          'Message',
          '--doc',
          'chat-api',
          '--rationale',
          'agreed',
        ])
      ).code,
    ).toBe(0);

    // ===== batch accept via --target =====
    const obj = { type: 'object', properties: { t: { type: 'string' } } };
    expect(
      (
        await cli('alice', [
          'propose',
          'schema',
          'Ping',
          '--doc',
          'chat-api',
          '--file',
          spec('ping.json', obj),
          '--expected-new',
        ])
      ).code,
    ).toBe(0);
    expect(
      (
        await cli('alice', [
          'propose',
          'schema',
          'Pong',
          '--doc',
          'chat-api',
          '--file',
          spec('pong.json', obj),
          '--expected-new',
        ])
      ).code,
    ).toBe(0);
    const batch = await cli('bob', [
      'accept',
      'schema',
      '--doc',
      'chat-api',
      '--target',
      'Ping',
      '--target',
      'Pong',
    ]);
    expect(batch.code).toBe(0);
    expect(batch.out).toContain('Ping');
    expect(batch.out).toContain('Pong');

    // ===== endpoint: propose (alice) → accept (bob) =====
    const ep = spec('ep.json', {
      summary: 'List recent messages',
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
    });
    // propose is file-only: omitting --file is a clean exit 2.
    const noFile = await cli('alice', [
      'propose',
      'endpoint',
      'GET',
      '/messages',
      '--doc',
      'chat-api',
    ]);
    expect(noFile.code).toBe(2);
    expect(noFile.out).toContain('spec file');
    expect(
      (
        await cli('alice', [
          'propose',
          'endpoint',
          'GET',
          '/messages',
          '--doc',
          'chat-api',
          '--file',
          ep,
          '--expected-new',
        ])
      ).code,
    ).toBe(0);

    // can't accept your own proposal (peer-only) → clean non-zero
    expect(
      (await cli('alice', ['accept', 'endpoint', 'GET', '/messages', '--doc', 'chat-api'])).code,
    ).not.toBe(0);
    expect(
      (await cli('bob', ['accept', 'endpoint', 'GET', '/messages', '--doc', 'chat-api'])).code,
    ).toBe(0);

    // ===== read verbs: show (body), list (--doc inferred — sole doc), diff (v1→v2) =====
    const show = await cli('bob', ['show', 'endpoint', 'GET', '/messages', '--doc', 'chat-api']);
    expect(show.code).toBe(0);
    expect(show.out).toContain('List recent messages');

    const list = await cli('bob', ['list', 'schema']); // no --doc: resolves to the only document
    expect(list.code).toBe(0);
    expect(list.out).toContain('User');
    expect(list.out).toContain('Message');

    const diff = await cli('bob', ['diff', 'schema', 'Message', '--doc', 'chat-api']);
    expect(diff.code).toBe(0);
    expect(diff.out).toContain('created_at'); // the field added in v2

    // ===== withdraw your own still-proposed version =====
    expect(
      (
        await cli('alice', [
          'propose',
          'schema',
          'Temp',
          '--doc',
          'chat-api',
          '--file',
          spec('temp.json', { type: 'object' }),
          '--expected-new',
        ])
      ).code,
    ).toBe(0);
    expect((await cli('alice', ['withdraw', 'schema', 'Temp', '--doc', 'chat-api'])).code).toBe(0);

    // ===== retraction: propose removing GET /messages (no dependents) → peer accepts =====
    const proposeRet = await cli('alice', [
      'propose',
      'retraction',
      '--doc',
      'chat-api',
      '--endpoint',
      'GET /messages',
      '--rationale',
      'dropping the poll',
    ]);
    expect(proposeRet.code).toBe(0);
    const rid = proposeRet.out.match(/retraction #(\d+)/)?.[1];
    expect(rid).toBeDefined();
    const acceptRet = await cli('bob', ['accept', 'retraction', rid ?? '', '--doc', 'chat-api']);
    expect(acceptRet.code).toBe(0);
    expect(acceptRet.out).toContain('accepted');

    // The endpoint is gone now; show no longer succeeds (the exact get-on-retracted exit code is a
    // server semantics detail, orthogonal to the grammar — assert only that it's no longer there).
    expect(
      (await cli('bob', ['show', 'endpoint', 'GET', '/messages', '--doc', 'chat-api'])).code,
    ).not.toBe(0);
  });

  it('admin verbs (client-level): grant observer, list members, revoke', async () => {
    const alice = new BrackishClient({ socketPath, identity: 'alice' });
    try {
      await alice.createDocument('admin-test');
      await alice.addMember('admin-test', 'observer', 'member');
      const members = await alice.listMembers('admin-test');
      expect(members.map((m) => m.identity).sort()).toEqual(['alice', 'observer']);
      expect(members.find((m) => m.identity === 'observer')?.role).toBe('member');

      await alice.removeMember('admin-test', 'observer');
      expect((await alice.listMembers('admin-test')).map((m) => m.identity)).toEqual(['alice']);
    } finally {
      await alice.close();
    }
  });
});
