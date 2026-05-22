// Cross-machine bootstrap: invite (mint), connect (redeem), parties (list), revoke.

import type { Command } from 'commander';
import { redeemInvite } from '../client/client.js';
import {
  defaultClientConfigPath,
  loadServerConfig,
  parseBindAddress,
  saveClientConfig,
} from '../io/config.js';
import { IdentitySchema } from '../lib/models.js';
import { formatParties } from '../render/output.js';
import { collect, emit, emitJson, errExit, inferReachableHost, withClient } from './common.js';

export function register(program: Command): void {
  program
    .command('invite <identity>')
    .description('server-side: mint a one-time invite for <identity> (TCP transport only)')
    .option('--ttl <seconds>', 'invite lifetime in seconds (default 3600)', '3600')
    .option(
      '--grant <doc>',
      'auto-grant the redeeming party membership of <doc> (repeatable; comma-separated also accepted). Without --grant, the peer redeems an account but has no document access until you explicitly run `brackish doc grant`.',
      collect,
      [] as string[],
    )
    .option('--json', 'output JSON')
    .action(async (identity: string, opts: { ttl: string; grant: string[]; json?: boolean }) =>
      withClient(async (client) => {
        const ttl = Number.parseInt(opts.ttl, 10);
        if (!Number.isFinite(ttl) || ttl < 1)
          errExit(2, 'invite: --ttl must be a positive integer');
        IdentitySchema.parse(identity);
        // Accept both repeated --grant and comma-separated values within a single flag.
        const grantDocs = opts.grant
          .flatMap((s) => s.split(','))
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        const inv = await client.createInvite(identity, ttl, grantDocs);
        const cfg = await loadServerAddrForInvite();
        const url = cfg.tcpUrl;
        if (opts.json) {
          emitJson({
            inviteToken: inv.inviteToken,
            identity: inv.identity,
            expiresAt: inv.expiresAt,
            grantDocs,
            connectCommand: `brackish connect ${url} --token ${inv.inviteToken} --identity ${identity}`,
            ...(cfg.hint ? { hint: cfg.hint } : {}),
          });
        } else {
          const hintLine = cfg.hint ? `\n  ${cfg.hint}` : '';
          const grantLine =
            grantDocs.length > 0
              ? `\n  on redeem: ${identity} becomes a member of ${grantDocs.join(', ')}`
              : `\n  (no docs granted — run \`brackish doc grant <doc> ${identity}\` after redeem)`;
          emit(
            `invite issued: identity=${identity}, expires=${inv.expiresAt}${grantLine}\n` +
              `share with peer:\n  brackish connect ${url} --token ${inv.inviteToken} --identity ${identity}${hintLine}`,
          );
        }
      }),
    );

  program
    .command('connect <url>')
    .description(
      'peer-side: redeem an invite, store the persistent token in ~/.brackish/config.toml',
    )
    .requiredOption('--token <tok>', 'invite token from `brackish invite`')
    .requiredOption('--identity <name>', 'self-declared label for this client (must match invite)')
    .action(async (url: string, opts: { token: string; identity: string }) => {
      IdentitySchema.parse(opts.identity);
      const persistent = await redeemInvite(url, opts.token);
      if (persistent.identity !== opts.identity) {
        errExit(
          1,
          `connect: server issued identity "${persistent.identity}" but you asked for "${opts.identity}"`,
        );
      }
      saveClientConfig({
        identity: persistent.identity,
        server: url,
        token: persistent.token,
      });
      emit(
        `connected as ${persistent.identity} → ${url}\nconfig written to ${defaultClientConfigPath()}`,
      );
    });

  program
    .command('parties')
    .description('list registered identities (TCP path only — socket clients are ephemeral)')
    .option('--json', 'output JSON')
    .action(async (opts: { json?: boolean }) =>
      withClient(async (client) => {
        const res = await client.listParties();
        if (opts.json) emitJson(res);
        else emit(formatParties(res.parties));
      }),
    );

  program
    .command('revoke <identity>')
    .description('invalidate a party identity and all its tokens')
    .action(async (identity: string) =>
      withClient(async (client) => {
        IdentitySchema.parse(identity);
        await client.revokeParty(identity);
        emit(`revoked ${identity}`);
      }),
    );
}

async function loadServerAddrForInvite(): Promise<{ tcpUrl: string; hint?: string }> {
  const fileCfg = loadServerConfig();
  if (fileCfg.bind === undefined) {
    errExit(
      2,
      'invite: this server has no TCP bind set; invites only make sense for cross-machine use.',
    );
  }
  const { host, port } = parseBindAddress(fileCfg.bind);
  const inferred = await inferReachableHost(host);
  return {
    tcpUrl: `http://${inferred.host}:${port}`,
    ...(inferred.hint ? { hint: inferred.hint } : {}),
  };
}
