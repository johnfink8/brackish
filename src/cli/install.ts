// `brackish install` / `uninstall` — copy (or remove) the Claude Code skill. That's all it does:
// brackish never edits your settings.json (no hooks, no permission rules). Sync is the foreground
// status/nap loop. To skip Claude's per-command approval prompts, add a `Bash(brackish *)` allow-rule
// to settings.json yourself.

import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import {
  claudeHome,
  defaultSkillDest,
  installSkill,
  projectClaudeHome,
  type Scope,
  uninstallSkill,
  userClaudeHome,
} from '../io/install.js';
import { errExit, sanitizeIdentity } from './common.js';

const PERMISSION_HINT =
  'brackish never edits settings.json. To skip Claude\'s per-command approval, add "Bash(brackish *)" to your settings.json allow-list.';

export function register(program: Command): void {
  program
    .command('install')
    .description('install the brackish skill (copies the skill dir; never edits settings.json)')
    .option(
      '--scope <user|project>',
      'user → ~/.claude (global); project → ./.claude (commit-able). Interactive if omitted.',
    )
    .option('--global', 'shortcut for --scope user')
    .option('--local', 'shortcut for --scope project')
    .option(
      '--dest <path>',
      'override skill dest (defaults to <home>/skills/brackish for the chosen scope)',
    )
    .option('--yes', 'non-interactive: assume yes to all confirmations (defaults scope to user)')
    .option('--force', 'overwrite existing skill dir')
    .action(
      async (opts: {
        scope?: string;
        global?: boolean;
        local?: boolean;
        dest?: string;
        yes?: boolean;
        force?: boolean;
      }) => {
        const scope = await resolveScope(opts);
        const home = claudeHome(scope);
        const dest = opts.dest ?? defaultSkillDest(home);

        const skillNote = existsSync(dest)
          ? opts.force
            ? 'OVERWRITE (force)'
            : 'exists — needs --force to overwrite'
          : 'create';
        process.stderr.write(
          `brackish install — plan (scope=${scope}, home=${home}):\n  skill: ${dest}\n    ${skillNote}\n`,
        );

        const doSkill = opts.yes || (await confirm('Install skill?', true));
        if (!doSkill) {
          process.stderr.write('brackish install: skipped\n');
          return;
        }
        const res = installSkill(dest, opts.force ? { force: true } : {});
        const yourHostname = sanitizeIdentity(hostname());
        process.stderr.write(
          [
            `\nbrackish install — done: wrote ${res.wroteFiles} files to ${res.destPath}\n`,
            'In Claude Code, just say what you want — the skill does the rest (starts the',
            'daemon, writes a client config). Examples:',
            '',
            '  /brackish invite <peer-name>             — pair with another Claude on another host',
            '  /brackish connect <line from peer>       — redeem an invite the peer just printed',
            "  let's negotiate the X API                — same-machine; the skill picks it up",
            '',
            `Your identity will default to "${yourHostname}". Override via \`brackish init --identity\` or by setting BRACKISH_IDENTITY.`,
            `\n${PERMISSION_HINT}`,
            '',
          ].join('\n'),
        );
      },
    );

  program
    .command('uninstall')
    .description('reverse `brackish install`: remove the skill dir')
    .option(
      '--scope <user|project>',
      'user → ~/.claude (global); project → ./.claude. Interactive if omitted.',
    )
    .option('--global', 'shortcut for --scope user')
    .option('--local', 'shortcut for --scope project')
    .option(
      '--dest <path>',
      'override skill dest (defaults to <home>/skills/brackish for the chosen scope)',
    )
    .option('--yes', 'non-interactive: assume yes to all confirmations (defaults scope to user)')
    .action(
      async (opts: {
        scope?: string;
        global?: boolean;
        local?: boolean;
        dest?: string;
        yes?: boolean;
      }) => {
        const scope = await resolveScope(opts);
        const home = claudeHome(scope);
        const dest = opts.dest ?? defaultSkillDest(home);

        const exists = existsSync(dest);
        process.stderr.write(
          `brackish uninstall — plan (scope=${scope}, home=${home}):\n  skill: ${dest}\n    ${exists ? 'remove' : 'nothing to remove'}\n`,
        );
        if (!exists) {
          process.stderr.write('brackish uninstall: nothing to remove\n');
          return;
        }
        const doSkill = opts.yes || (await confirm('Uninstall skill?', true));
        if (!doSkill) {
          process.stderr.write('brackish uninstall: skipped\n');
          return;
        }
        const removed = uninstallSkill(dest);
        process.stderr.write(
          `\nbrackish uninstall — done: ${removed ? `removed ${dest}` : 'nothing to remove'}\n`,
        );
      },
    );
}

/** Determine the install scope from flags or prompt. Defaults to `user` when non-interactive. */
async function resolveScope(opts: {
  scope?: string;
  global?: boolean;
  local?: boolean;
  yes?: boolean;
}): Promise<Scope> {
  if (opts.global && opts.local) {
    errExit(2, 'install: pass at most one of --global and --local');
  }
  if (opts.scope !== undefined && opts.scope !== 'user' && opts.scope !== 'project') {
    errExit(2, `install: invalid --scope ${opts.scope} (expected: user, project)`);
  }
  const flagged: Scope | null = opts.global
    ? 'user'
    : opts.local
      ? 'project'
      : opts.scope === 'user' || opts.scope === 'project'
        ? opts.scope
        : null;
  if (flagged) return flagged;
  if (opts.yes || !process.stdin.isTTY) return 'user';

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    process.stderr.write(
      [
        'Install scope?',
        `  1) user    — ${userClaudeHome()}      (global; applies to every Claude session)`,
        `  2) project — ${projectClaudeHome()}   (commit-able; applies when Claude is launched from this dir or any descendant)`,
        '',
      ].join('\n'),
    );
    while (true) {
      const ans = (await rl.question('Choose [1/2] (default 1): ')).trim().toLowerCase();
      if (ans === '' || ans === '1' || ans === 'user' || ans === 'u') return 'user';
      if (ans === '2' || ans === 'project' || ans === 'p') return 'project';
      process.stderr.write('  please answer 1 (user) or 2 (project)\n');
    }
  } finally {
    rl.close();
  }
}

async function confirm(prompt: string, defaultYes: boolean): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const suffix = defaultYes ? '[Y/n]' : '[y/N]';
    const ans = (await rl.question(`${prompt} ${suffix} `)).trim().toLowerCase();
    if (ans === '') return defaultYes;
    return ans === 'y' || ans === 'yes';
  } finally {
    rl.close();
  }
}
