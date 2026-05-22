// Message + event flow: send, read, wait, inbox, nap, watch.

import type { Command } from 'commander';
import { formatEvents, formatEventsStream, formatInbox } from '../render/output.js';
import { emit, emitJson, errExit, readStdin, sleep, withClient } from './common.js';

export function register(program: Command): void {
  program
    .command('send <doc> [text]')
    .description('post a message to <doc>. Use "-" to read body from stdin.')
    .action(async (document: string, text: string | undefined) =>
      withClient(async (client) => {
        const body = text === '-' ? await readStdin() : text;
        if (!body) errExit(2, 'send: provide message text or pass "-" to read stdin');
        const event = await client.sendMessage(document, body);
        emit(`sent event #${event.id} to ${document}`);
      }),
    );

  program
    .command('read <doc>')
    .description(
      "list events in <doc> since the caller's cursor (advances the cursor). --tail N peeks at the last N events without advancing.",
    )
    .option('--since <n>', 'override cursor (exclusive lower bound)')
    .option('--limit <n>', 'max events to return', '200')
    .option('--tail <n>', 'show the last N events in chronological order, no cursor advance')
    .option('--json', 'output JSON')
    .action(
      async (
        document: string,
        opts: { since?: string; limit: string; tail?: string; json?: boolean },
      ) =>
        withClient(async (client) => {
          const tailN = opts.tail !== undefined ? Number.parseInt(opts.tail, 10) : undefined;
          if (tailN !== undefined && opts.since !== undefined) {
            errExit(2, 'read: --tail and --since are mutually exclusive');
          }
          if (tailN !== undefined) {
            const res = await client.listEvents(document, { tail: tailN });
            if (opts.json) emitJson(res);
            else emit(formatEvents(res.events, res.cursor));
            return;
          }
          const sinceN = opts.since !== undefined ? Number.parseInt(opts.since, 10) : undefined;
          const limitN = Number.parseInt(opts.limit, 10);
          const res = await client.listEvents(document, {
            ...(sinceN !== undefined ? { since: sinceN } : {}),
            limit: limitN,
          });
          if (opts.json) emitJson(res);
          else emit(formatEvents(res.events, res.cursor));
        }),
    );

  program
    .command('wait <doc>')
    .description('long-poll <doc>: block until new events arrive or --timeout elapses')
    .option('--timeout <seconds>', 'max seconds to block (1..300)', '30')
    .option('--since <n>', 'override cursor (exclusive lower bound)')
    .option('--json', 'output JSON')
    .action(async (document: string, opts: { timeout: string; since?: string; json?: boolean }) =>
      withClient(async (client) => {
        const timeoutSeconds = Number.parseFloat(opts.timeout);
        const sinceN = opts.since !== undefined ? Number.parseInt(opts.since, 10) : undefined;
        const res = await client.wait(document, {
          timeoutSeconds,
          ...(sinceN !== undefined ? { since: sinceN } : {}),
        });
        if (opts.json) emitJson(res);
        else emit(formatEvents(res.events, res.cursor));
      }),
    );

  program
    .command('inbox')
    .description('summary of all documents with new events for the current identity')
    .option('--json', 'output JSON')
    .option('--quiet-if-empty', 'print nothing (and exit 0) if there are no new events anywhere')
    .action(async (opts: { json?: boolean; quietIfEmpty?: boolean }) =>
      withClient(async (client) => {
        const res = await client.inbox();
        if (opts.quietIfEmpty && res.documents.length === 0) return;
        if (opts.json) emitJson(res);
        else emit(formatInbox(res.identity, res.documents));
      }),
    );

  program
    .command('nap')
    .description(
      "sleep --seconds, then snapshot the inbox. Use when there's nothing to do but wait for the peer — setTimeout-shape, not a recurring monitor.",
    )
    .option('--seconds <n>', 'sleep duration in seconds', '60')
    .option('--json', 'output JSON')
    .action(async (opts: { seconds: string; json?: boolean }) =>
      withClient(async (client) => {
        const seconds = Number.parseFloat(opts.seconds);
        if (!Number.isFinite(seconds) || seconds < 0) {
          errExit(2, `--seconds must be a non-negative number (got "${opts.seconds}")`);
        }
        await sleep(seconds * 1000);
        const res = await client.inbox();
        if (opts.json) emitJson(res);
        else if (res.documents.length === 0) {
          emit(`(no peer activity in the last ${seconds}s)`);
        } else {
          emit(formatInbox(res.identity, res.documents));
        }
      }),
    );

  program
    .command('watch [document]')
    .description('foreground live tail of events; ^C to stop. Omit <doc> to use --all.')
    .option('--all', 'tail every document (uses inbox + iterative wait)')
    .option('--timeout <seconds>', 'inner long-poll timeout per iteration', '60')
    .action(async (document: string | undefined, opts: { all?: boolean; timeout: string }) =>
      withClient(async (client) => {
        const timeoutSeconds = Number.parseFloat(opts.timeout);
        if (document && !opts.all) {
          for (;;) {
            const res = await client.wait(document, { timeoutSeconds });
            if (res.events.length > 0) process.stdout.write(`${formatEventsStream(res.events)}\n`);
          }
        } else if (opts.all) {
          for (;;) {
            const ib = await client.inbox();
            for (const entry of ib.documents) {
              const ev = await client.listEvents(entry.documentName);
              if (ev.events.length > 0) {
                process.stdout.write(`[${entry.documentName}]\n${formatEventsStream(ev.events)}\n`);
              }
            }
            await sleep(timeoutSeconds * 1000);
          }
        } else {
          errExit(2, 'watch: pass a <doc> or --all');
        }
      }),
    );
}
