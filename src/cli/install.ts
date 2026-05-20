// `brackish install` / `uninstall` / `hook-snippet` / `activate` / `deactivate` —
// Claude Code skill + hook wiring. `activate`/`deactivate` are the day-to-day mute toggle for
// when you're switching from negotiating contracts to implementing them and don't want the
// UserPromptSubmit hook re-pinging.

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Command } from 'commander';
import { brackishHome, defaultSocketPath } from '../io/config.js';
import {
  BRACKISH_PERMISSION_PATTERN,
  claudeHome,
  defaultSkillDest,
  hookSnippet,
  inspectInstall,
  installHook,
  installPermission,
  installSkill,
  projectClaudeHome,
  type Scope,
  uninstallHook,
  uninstallPermission,
  uninstallSkill,
  userClaudeHome,
} from '../io/install.js';
import { errExit, sanitizeIdentity } from './common.js';

export function register(program: Command): void {
  program
    .command('install')
    .description(
      'install the brackish skill and (with confirmation) the inbox UserPromptSubmit hook',
    )
    .option('--skill-only', 'install just the skill, not the hook')
    .option('--hook-only', 'install just the hook, not the skill')
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
    .option(
      '--permission',
      `add an allow-rule for ${BRACKISH_PERMISSION_PATTERN} to settings.json (so Claude won't prompt before running brackish commands); default off`,
    )
    .option('--yes', 'non-interactive: assume yes to all confirmations (defaults scope to user)')
    .option('--force', 'overwrite existing skill dir')
    .action(
      async (opts: {
        skillOnly?: boolean;
        hookOnly?: boolean;
        scope?: string;
        global?: boolean;
        local?: boolean;
        dest?: string;
        permission?: boolean;
        yes?: boolean;
        force?: boolean;
      }) => {
        if (opts.skillOnly && opts.hookOnly) {
          errExit(2, 'install: pass at most one of --skill-only or --hook-only');
        }
        const scope = await resolveScope(opts);
        const home = claudeHome(scope);
        const dest = opts.dest ?? defaultSkillDest(home);
        const plan = inspectInstall({ home, dest });

        process.stderr.write(`brackish install — plan (scope=${scope}, home=${home}):\n`);
        if (!opts.hookOnly) {
          const skillNote = plan.skill.exists
            ? opts.force
              ? 'OVERWRITE (force)'
              : 'exists — needs --force to overwrite'
            : 'create';
          process.stderr.write(`  skill: ${plan.skill.destPath}\n    ${skillNote}\n`);
        }
        if (!opts.skillOnly) {
          if (plan.hook.settingsParseError) {
            errExit(
              2,
              `install: settings.json at ${plan.hook.settingsPath} is malformed:\n  ${plan.hook.settingsParseError}\nFix it (or move it aside) and re-run.`,
            );
          }
          const hookNote = plan.hook.needsMigration
            ? `migrate legacy hook entry into the matcher+hooks wrapper Claude Code requires (other hooks preserved: ${plan.hook.otherHookCount})`
            : plan.hook.alreadyInstalled
              ? 'already installed (no edit needed)'
              : plan.hook.settingsExists
                ? `merge into existing settings.json (other hooks preserved: ${plan.hook.otherHookCount})`
                : `create settings.json`;
          process.stderr.write(`  hook: ${plan.hook.settingsPath}\n    ${hookNote}\n`);
        }
        const permissionNote = plan.permission.alreadyInstalled
          ? 'already present (no edit needed)'
          : `add allow-rule ${plan.permission.pattern} (other allow entries preserved: ${plan.permission.otherAllowCount})`;
        process.stderr.write(`  perm: ${plan.permission.settingsPath}\n    ${permissionNote}\n`);

        const doSkill = !opts.hookOnly && (opts.yes || (await confirm('Install skill?', true)));
        const hookSettled = plan.hook.alreadyInstalled && !plan.hook.needsMigration;
        const doHook =
          !opts.skillOnly && !hookSettled && (opts.yes || (await confirm('Install hook?', true)));
        const doPermission = plan.permission.alreadyInstalled
          ? false
          : opts.permission === true
            ? true
            : opts.yes
              ? false
              : await confirm(`Add ${plan.permission.pattern} to settings.json?`, false);

        const summary: string[] = [];
        if (doSkill) {
          const res = installSkill(dest, opts.force ? { force: true } : {});
          summary.push(`  skill: wrote ${res.wroteFiles} files to ${res.destPath}`);
        } else if (!opts.hookOnly) {
          summary.push('  skill: skipped');
        }
        if (doHook) {
          const scriptPath = `${dest}/hooks/inbox-on-prompt.sh`;
          const res = installHook(scriptPath, home);
          if (res.alreadyInstalled) summary.push('  hook: already installed (skipped)');
          else
            summary.push(
              `  hook: added entry → ${res.settingsPath}${res.backupPath ? ` (backup: ${res.backupPath})` : ''}`,
            );
        } else if (!opts.skillOnly) {
          summary.push(hookSettled ? '  hook: already installed (skipped)' : '  hook: skipped');
        }
        if (doPermission) {
          const res = installPermission(plan.permission.pattern, home);
          if (res.alreadyInstalled) summary.push('  perm: already present (skipped)');
          else
            summary.push(
              `  perm: added ${plan.permission.pattern} → ${res.settingsPath}${res.backupPath ? ` (backup: ${res.backupPath})` : ''}`,
            );
        } else {
          summary.push(
            plan.permission.alreadyInstalled
              ? '  perm: already present (skipped)'
              : '  perm: skipped',
          );
        }

        process.stderr.write(`\nbrackish install — done:\n${summary.join('\n')}\n`);
        if (doSkill || doHook || doPermission) {
          const yourHostname = sanitizeIdentity(hostname());
          process.stderr.write(
            [
              '',
              'In Claude Code, just say what you want — the skill does the rest (starts the',
              'daemon, writes a client config). Examples:',
              '',
              '  /brackish invite <peer-name>             — pair with another Claude on another host',
              '  /brackish connect <line from peer>       — redeem an invite the peer just printed',
              "  let's negotiate the X API                — same-machine; the skill picks it up",
              '',
              `Your identity will default to "${yourHostname}". Override via \`brackish init --identity\` or by setting BRACKISH_IDENTITY.`,
              '',
            ].join('\n'),
          );
        }
      },
    );

  program
    .command('uninstall')
    .description('reverse `brackish install`: remove the skill dir + our hook entry')
    .option('--skill-only', 'remove only the skill, leave the hook')
    .option('--hook-only', 'remove only the hook, leave the skill')
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
        skillOnly?: boolean;
        hookOnly?: boolean;
        scope?: string;
        global?: boolean;
        local?: boolean;
        dest?: string;
        yes?: boolean;
      }) => {
        if (opts.skillOnly && opts.hookOnly) {
          errExit(2, 'uninstall: pass at most one of --skill-only or --hook-only');
        }
        const scope = await resolveScope(opts);
        const home = claudeHome(scope);
        const dest = opts.dest ?? defaultSkillDest(home);
        const scriptPath = `${dest}/hooks/inbox-on-prompt.sh`;

        const plan = inspectInstall({ home, dest });
        process.stderr.write(`brackish uninstall — plan (scope=${scope}, home=${home}):\n`);
        if (!opts.hookOnly) {
          process.stderr.write(
            `  skill: ${plan.skill.destPath}\n    ${plan.skill.exists ? 'remove' : 'nothing to remove'}\n`,
          );
        }
        const hasHookEntry = plan.hook.alreadyInstalled || plan.hook.needsMigration;
        if (!opts.skillOnly) {
          process.stderr.write(
            `  hook:  ${plan.hook.settingsPath}\n    ${hasHookEntry ? 'remove our entry' : 'nothing to remove'}\n`,
          );
          process.stderr.write(
            `  perm:  ${plan.permission.settingsPath}\n    ${plan.permission.alreadyInstalled ? `remove allow-rule ${plan.permission.pattern}` : 'nothing to remove'}\n`,
          );
        }

        const doSkill =
          !opts.hookOnly &&
          plan.skill.exists &&
          (opts.yes || (await confirm('Uninstall skill?', true)));
        const doHook =
          !opts.skillOnly && hasHookEntry && (opts.yes || (await confirm('Uninstall hook?', true)));
        const doPermission =
          !opts.skillOnly &&
          plan.permission.alreadyInstalled &&
          (opts.yes || (await confirm(`Remove ${plan.permission.pattern}?`, true)));

        const summary: string[] = [];
        if (doSkill) {
          const removed = uninstallSkill(dest);
          summary.push(removed ? `  skill: removed ${dest}` : '  skill: nothing to remove');
        } else if (!opts.hookOnly && plan.skill.exists) {
          summary.push('  skill: skipped');
        } else if (!opts.hookOnly) {
          summary.push('  skill: nothing to remove');
        }
        if (doHook) {
          const res = uninstallHook(scriptPath, home);
          summary.push(
            res.removed
              ? `  hook: removed entry from ${res.settingsPath}${res.backupPath ? ` (backup: ${res.backupPath})` : ''}`
              : '  hook: nothing to remove',
          );
        } else if (!opts.skillOnly) {
          summary.push(hasHookEntry ? '  hook: skipped' : '  hook: nothing to remove');
        }
        if (doPermission) {
          const res = uninstallPermission(plan.permission.pattern, home);
          summary.push(
            res.removed
              ? `  perm: removed ${plan.permission.pattern} from ${res.settingsPath}${res.backupPath ? ` (backup: ${res.backupPath})` : ''}`
              : '  perm: nothing to remove',
          );
        } else if (!opts.skillOnly) {
          summary.push(
            plan.permission.alreadyInstalled ? '  perm: skipped' : '  perm: nothing to remove',
          );
        }

        process.stderr.write(`\nbrackish uninstall — done:\n${summary.join('\n')}\n`);
      },
    );

  program
    .command('hook-snippet')
    .description('print the settings.json JSON fragment for the inbox hook (writes nothing)')
    .option('--scope <user|project>', 'pick the home that resolves the skill dest (default user)')
    .option('--global', 'shortcut for --scope user')
    .option('--local', 'shortcut for --scope project')
    .option('--dest <path>', 'override skill destination')
    .action((opts: { scope?: string; global?: boolean; local?: boolean; dest?: string }) => {
      const scope: Scope = opts.local ? 'project' : opts.scope === 'project' ? 'project' : 'user';
      const home = claudeHome(scope);
      const dest = opts.dest ?? defaultSkillDest(home);
      const scriptPath = `${dest}/hooks/inbox-on-prompt.sh`;
      process.stdout.write(`${hookSnippet(scriptPath)}\n`);
    });

  program
    .command('deactivate')
    .description(
      "mute brackish for now: stop the daemon (if running) and remove the UserPromptSubmit hook. Skill files + permission rule stay in place. Use when you're switching from negotiating to implementing and don't want the hook re-pinging.",
    )
    .option('--scope <user|project>', 'which `.claude/` home to edit; auto-detects if omitted')
    .option('--global', 'shortcut for --scope user')
    .option('--local', 'shortcut for --scope project')
    .option('--dest <path>', 'override skill dest (defaults to <home>/skills/brackish)')
    .option('--yes', 'non-interactive')
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
        const scriptPath = `${dest}/hooks/inbox-on-prompt.sh`;
        const lines: string[] = [];

        const daemonResult = await stopDaemonIfRunning();
        lines.push(`  daemon: ${daemonResult}`);

        const hookRes = uninstallHook(scriptPath, home);
        lines.push(
          hookRes.removed
            ? `  hook:   removed from ${hookRes.settingsPath}${hookRes.backupPath ? ` (backup: ${hookRes.backupPath})` : ''}`
            : `  hook:   nothing to remove`,
        );

        process.stderr.write(
          `brackish deactivate (scope=${scope}, home=${home}):\n${lines.join('\n')}\n` +
            `\nskill files preserved at ${dest}; permission allow-rule preserved.\n` +
            `→ run \`brackish activate\` to re-enable the hook when you're back to negotiating.\n`,
        );
      },
    );

  program
    .command('activate')
    .description(
      're-enable the brackish UserPromptSubmit hook (the inverse of `brackish deactivate`). Daemon stays down — start it explicitly with `brackish up` when ready.',
    )
    .option('--scope <user|project>', 'which `.claude/` home to edit; auto-detects if omitted')
    .option('--global', 'shortcut for --scope user')
    .option('--local', 'shortcut for --scope project')
    .option('--dest <path>', 'override skill dest (defaults to <home>/skills/brackish)')
    .option('--yes', 'non-interactive')
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
        const scriptPath = `${dest}/hooks/inbox-on-prompt.sh`;
        if (!existsSync(scriptPath)) {
          errExit(
            2,
            `activate: hook script not found at ${scriptPath}. Run \`brackish install\` first (or pass --dest to point at an existing skill).`,
          );
        }
        const res = installHook(scriptPath, home);
        process.stderr.write(
          `brackish activate (scope=${scope}, home=${home}):\n` +
            (res.alreadyInstalled
              ? `  hook:   already present (no edit needed)\n`
              : `  hook:   added → ${res.settingsPath}${res.backupPath ? ` (backup: ${res.backupPath})` : ''}\n`) +
            `\n→ run \`brackish up\` to start the daemon when ready (the hook stays silent while the daemon is down).\n`,
        );
      },
    );
}

/** Stop the daemon if a PID file is found and the process responds to SIGTERM. Returns a
 *  one-line status string for the activate/deactivate summary. Mirrors `brackish down`'s logic
 *  in cli/daemon.ts but inlined here to keep the dependency one-way. */
async function stopDaemonIfRunning(): Promise<string> {
  const pidPath = join(brackishHome(), 'serve.pid');
  if (!existsSync(pidPath)) {
    return existsSync(defaultSocketPath())
      ? `socket present at ${defaultSocketPath()} but no PID file (kill manually if needed)`
      : 'not running';
  }
  const pid = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
  if (!Number.isFinite(pid)) return `corrupt PID file at ${pidPath}`;
  try {
    process.kill(pid, 'SIGTERM');
  } catch (e) {
    const code = e instanceof Error && 'code' in e ? e.code : undefined;
    if (code === 'ESRCH') {
      try {
        unlinkSync(pidPath);
      } catch {
        /* */
      }
      try {
        unlinkSync(defaultSocketPath());
      } catch {
        /* */
      }
      return `stale PID ${pid} cleaned up`;
    }
    throw e;
  }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!existsSync(defaultSocketPath())) return `stopped (pid ${pid})`;
    await sleep(100);
  }
  return `SIGTERM sent to pid ${pid} but socket persists; check ${join(brackishHome(), 'serve.log')}`;
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
