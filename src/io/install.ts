// `brackish install` / `uninstall` / `hook-snippet` machinery.
//
// Design constraints:
//   - never overwrite ~/.claude/settings.json silently; always parse-then-write with a backup
//   - "already installed" is detected precisely (by matching the resolved script path), so
//     reruns are no-ops, not double-adds
//   - if settings.json has an unexpected shape, bail loudly without touching the file
//   - the only file we ever read for "bundled skill" is one we ship in the npm tarball, located
//     at the package root via import.meta.url; works the same in dev and in installed packages

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// --- paths ---

export type Scope = 'user' | 'project';

/** User-scoped Claude home: `$CLAUDE_HOME` if set, else `~/.claude`. Applies to every Claude session. */
export function userClaudeHome(): string {
  return process.env.CLAUDE_HOME ?? join(homedir(), '.claude');
}

/** Project-scoped Claude home: `<cwd>/.claude`. Claude Code auto-discovers this when launched from cwd or any descendant. */
export function projectClaudeHome(cwd: string = process.cwd()): string {
  return join(cwd, '.claude');
}

export function claudeHome(scope: Scope = 'user', cwd: string = process.cwd()): string {
  return scope === 'project' ? projectClaudeHome(cwd) : userClaudeHome();
}

export function defaultSkillDest(home: string = claudeHome()): string {
  return join(home, 'skills', 'brackish');
}

export function settingsJsonPath(home: string = claudeHome()): string {
  return join(home, 'settings.json');
}

/** Locate the bundled skill/ directory. Works in dev (src/io/) and in an installed package (dist/). */
export function bundledSkillDir(): string {
  // src/io/install.ts -> <root>/skill (dev via tsx)
  // dist/cli.js       -> <root>/skill (installed npm package, flat bundle)
  // Try one level up first (dist), then two (dev). Whichever exists wins.
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const flat = resolve(thisDir, '..', 'skill');
  if (existsSync(flat)) return flat;
  return resolve(thisDir, '..', '..', 'skill');
}

// --- inspection ---

export type SkillInspection = {
  destPath: string;
  exists: boolean;
};

export type HookInspection = {
  scriptPath: string;
  settingsPath: string;
  settingsExists: boolean;
  settingsParseError: string | null;
  /** A correctly-wrapped entry with our command is present. */
  alreadyInstalled: boolean;
  /** A bare-handler entry with our command is present (older shape; needs migration). */
  needsMigration: boolean;
  otherHookCount: number;
};

export type PermissionInspection = {
  pattern: string;
  settingsPath: string;
  alreadyInstalled: boolean;
  otherAllowCount: number;
};

export type InstallPlan = {
  skill: SkillInspection;
  hook: HookInspection;
  permission: PermissionInspection;
};

/** The blanket permission entry: allow any `brackish` subcommand without prompting. */
export const BRACKISH_PERMISSION_PATTERN = 'Bash(brackish *)';

// settings.json shape per https://code.claude.com/docs/en/hooks. Each event maps to an array of
// matcher groups, each group has an inner `hooks` array of actual handlers. The wrapper is
// required even for events like UserPromptSubmit that ignore the matcher value.
//
// We do NOT own settings.json end-to-end — Claude Code writes parts of it. So the read path
// is a genuine boundary: zod-validate at the parse, treat the result as a real type downstream.
const HookHandlerSchema = z
  .object({ type: z.string().optional(), command: z.string().optional() })
  .passthrough();
const HookMatcherGroupSchema = z
  .object({ matcher: z.string().optional(), hooks: z.array(HookHandlerSchema).optional() })
  .passthrough();
type HookHandler = z.infer<typeof HookHandlerSchema>;
type HookMatcherGroup = z.infer<typeof HookMatcherGroupSchema>;

// settings.json belongs to Claude Code, not brackish — we edit two narrow keys
// (hooks.UserPromptSubmit and permissions.allow) and need to round-trip the rest unchanged.
// The schema is loose at the keys we don't touch (`.passthrough()`); the structural checks in
// installHook/installPermission validate the keys we do.
const ParsedSettingsSchema = z
  .object({
    hooks: z
      .object({
        UserPromptSubmit: z.array(z.union([HookMatcherGroupSchema, HookHandlerSchema])).optional(),
      })
      .passthrough()
      .optional(),
    permissions: z
      .object({
        allow: z.array(z.string()).optional(),
        deny: z.array(z.string()).optional(),
        ask: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
type ParsedSettings = z.infer<typeof ParsedSettingsSchema>;

function parseSettings(raw: string): ParsedSettings {
  return ParsedSettingsSchema.parse(JSON.parse(raw));
}

/** True if `e` is a matcher-group wrapper (has a `hooks` array), false if it's a bare handler. */
function isMatcherGroup(e: HookMatcherGroup | HookHandler): e is HookMatcherGroup {
  return 'hooks' in e && Array.isArray(e.hooks);
}

/** Flatten the (possibly mixed-shape) entry list into the handler commands. */
function commandsIn(entries: Array<HookMatcherGroup | HookHandler> | undefined): string[] {
  if (!entries) return [];
  const out: string[] = [];
  for (const e of entries) {
    if (isMatcherGroup(e)) {
      for (const h of e.hooks ?? []) if (typeof h.command === 'string') out.push(h.command);
    } else if (typeof e.command === 'string') {
      out.push(e.command);
    }
  }
  return out;
}

export function inspectInstall(opts: { home?: string; dest?: string } = {}): InstallPlan {
  const home = opts.home ?? claudeHome();
  const dest = opts.dest ?? defaultSkillDest(home);
  const scriptPath = join(dest, 'hooks', 'inbox-on-prompt.sh');
  const settingsPath = settingsJsonPath(home);

  const skill: SkillInspection = { destPath: dest, exists: existsSync(dest) };

  const settingsExists = existsSync(settingsPath);
  let settingsParseError: string | null = null;
  let alreadyInstalled = false;
  let needsMigration = false;
  let otherHookCount = 0;
  let permissionInstalled = false;
  let otherAllowCount = 0;

  if (settingsExists) {
    try {
      const parsed = parseSettings(readFileSync(settingsPath, 'utf8'));
      const entries = parsed.hooks?.UserPromptSubmit ?? [];
      alreadyInstalled = entries.some(
        (e) => isMatcherGroup(e) && (e.hooks ?? []).some((h) => h.command === scriptPath),
      );
      needsMigration = entries.some((e) => !isMatcherGroup(e) && e.command === scriptPath);
      otherHookCount = commandsIn(entries).filter((c) => c !== scriptPath).length;

      const allow = parsed.permissions?.allow ?? [];
      permissionInstalled = allow.includes(BRACKISH_PERMISSION_PATTERN);
      otherAllowCount = allow.filter((p) => p !== BRACKISH_PERMISSION_PATTERN).length;
    } catch (e) {
      settingsParseError = e instanceof Error ? e.message : String(e);
    }
  }

  return {
    skill,
    hook: {
      scriptPath,
      settingsPath,
      settingsExists,
      settingsParseError,
      alreadyInstalled,
      needsMigration,
      otherHookCount,
    },
    permission: {
      pattern: BRACKISH_PERMISSION_PATTERN,
      settingsPath,
      alreadyInstalled: permissionInstalled,
      otherAllowCount,
    },
  };
}

// --- execution ---

export type SkillInstallResult = { wroteFiles: number; destPath: string };

export function installSkill(destPath: string, opts: { force?: boolean } = {}): SkillInstallResult {
  const src = bundledSkillDir();
  if (!existsSync(src)) {
    throw new Error(`bundled skill directory not found at ${src} (broken install?)`);
  }
  if (existsSync(destPath)) {
    if (!opts.force) {
      throw new Error(`destination ${destPath} already exists (re-run with --force to overwrite)`);
    }
    rmSync(destPath, { recursive: true, force: true });
  }
  mkdirSync(dirname(destPath), { recursive: true });
  cpSync(src, destPath, { recursive: true });
  // Make the hook script executable. cpSync preserves mode but be defensive in case the source
  // wasn't chmod +x in git.
  const hookScript = join(destPath, 'hooks', 'inbox-on-prompt.sh');
  if (existsSync(hookScript)) chmodSync(hookScript, 0o755);
  return { wroteFiles: countFilesRecursive(destPath), destPath };
}

export type HookInstallResult = {
  backupPath: string | null;
  alreadyInstalled: boolean;
  settingsPath: string;
};

export function installHook(scriptPath: string, home: string = claudeHome()): HookInstallResult {
  const settingsPath = settingsJsonPath(home);
  mkdirSync(dirname(settingsPath), { recursive: true });

  let parsed: ParsedSettings = {};
  let backupPath: string | null = null;
  let raw = '';

  if (existsSync(settingsPath)) {
    raw = readFileSync(settingsPath, 'utf8');
    try {
      parsed = parseSettings(raw);
    } catch (e) {
      throw new Error(
        `${settingsPath} is not valid JSON (${e instanceof Error ? e.message : e}); refusing to touch it`,
      );
    }
    if (parsed.hooks !== undefined && (typeof parsed.hooks !== 'object' || parsed.hooks === null)) {
      throw new Error(`${settingsPath}: 'hooks' is not an object; refusing to edit`);
    }
    if (
      parsed.hooks?.UserPromptSubmit !== undefined &&
      !Array.isArray(parsed.hooks.UserPromptSubmit)
    ) {
      throw new Error(
        `${settingsPath}: 'hooks.UserPromptSubmit' is not an array; refusing to edit`,
      );
    }
  }

  const entries = parsed.hooks?.UserPromptSubmit;
  const hasBare =
    Array.isArray(entries) && entries.some((e) => !isMatcherGroup(e) && e.command === scriptPath);
  const hasWrapped =
    Array.isArray(entries) &&
    entries.some((e) => isMatcherGroup(e) && (e.hooks ?? []).some((h) => h.command === scriptPath));

  if (hasWrapped && !hasBare) {
    return { backupPath: null, alreadyInstalled: true, settingsPath };
  }

  if (raw) {
    backupPath = `${settingsPath}.bak.${timestampSlug()}`;
    writeFileSync(backupPath, raw);
  }

  if (hasBare) removeEntriesByCommand(parsed, scriptPath);

  if (!parsed.hooks) parsed.hooks = {};
  if (!Array.isArray(parsed.hooks.UserPromptSubmit)) parsed.hooks.UserPromptSubmit = [];
  // matcher is ignored for UserPromptSubmit but the wrapper is mandatory.
  parsed.hooks.UserPromptSubmit.push({
    matcher: '',
    hooks: [{ type: 'command', command: scriptPath }],
  });

  writeFileSync(settingsPath, `${JSON.stringify(parsed, null, 2)}\n`);
  return { backupPath, alreadyInstalled: false, settingsPath };
}

/** Strip any entry under `hooks.UserPromptSubmit` (either shape) whose command matches.
 *  Mutates `parsed`; returns true if anything was removed. */
function removeEntriesByCommand(parsed: ParsedSettings, scriptPath: string): boolean {
  const entries = parsed.hooks?.UserPromptSubmit;
  if (!Array.isArray(entries)) return false;
  let mutated = false;
  const keptGroups: Array<HookMatcherGroup | HookHandler> = [];
  for (const e of entries) {
    if (isMatcherGroup(e)) {
      const keptHooks = (e.hooks ?? []).filter((h) => h.command !== scriptPath);
      if (keptHooks.length !== (e.hooks ?? []).length) mutated = true;
      if (keptHooks.length > 0) keptGroups.push({ ...e, hooks: keptHooks });
    } else if (e.command === scriptPath) {
      mutated = true;
    } else {
      keptGroups.push(e);
    }
  }
  if (mutated && parsed.hooks) {
    if (keptGroups.length === 0) delete parsed.hooks.UserPromptSubmit;
    else parsed.hooks.UserPromptSubmit = keptGroups;
  }
  return mutated;
}

// --- uninstall ---

export function uninstallSkill(destPath: string): boolean {
  if (!existsSync(destPath)) return false;
  rmSync(destPath, { recursive: true, force: true });
  return true;
}

export type HookUninstallResult = {
  backupPath: string | null;
  removed: boolean;
  settingsPath: string;
};

export function uninstallHook(
  scriptPath: string,
  home: string = claudeHome(),
): HookUninstallResult {
  const settingsPath = settingsJsonPath(home);
  if (!existsSync(settingsPath)) return { backupPath: null, removed: false, settingsPath };

  const raw = readFileSync(settingsPath, 'utf8');
  let parsed: ParsedSettings;
  try {
    parsed = parseSettings(raw);
  } catch (e) {
    throw new Error(
      `${settingsPath} is not valid JSON (${e instanceof Error ? e.message : e}); refusing to touch it`,
    );
  }

  const removed = removeEntriesByCommand(parsed, scriptPath);
  if (!removed) return { backupPath: null, removed: false, settingsPath };

  if (parsed.hooks && Object.keys(parsed.hooks).length === 0) delete parsed.hooks;

  const backupPath = `${settingsPath}.bak.${timestampSlug()}`;
  writeFileSync(backupPath, raw);
  writeFileSync(settingsPath, `${JSON.stringify(parsed, null, 2)}\n`);
  return { backupPath, removed: true, settingsPath };
}

// --- permission rule ---

export type PermissionInstallResult = {
  backupPath: string | null;
  alreadyInstalled: boolean;
  settingsPath: string;
};

export function installPermission(
  pattern: string = BRACKISH_PERMISSION_PATTERN,
  home: string = claudeHome(),
): PermissionInstallResult {
  const settingsPath = settingsJsonPath(home);
  mkdirSync(dirname(settingsPath), { recursive: true });

  let parsed: ParsedSettings = {};
  let raw = '';
  if (existsSync(settingsPath)) {
    raw = readFileSync(settingsPath, 'utf8');
    try {
      parsed = parseSettings(raw);
    } catch (e) {
      throw new Error(
        `${settingsPath} is not valid JSON (${e instanceof Error ? e.message : e}); refusing to touch it`,
      );
    }
    if (
      parsed.permissions !== undefined &&
      (typeof parsed.permissions !== 'object' || parsed.permissions === null)
    ) {
      throw new Error(`${settingsPath}: 'permissions' is not an object; refusing to edit`);
    }
    if (parsed.permissions?.allow !== undefined && !Array.isArray(parsed.permissions.allow)) {
      throw new Error(`${settingsPath}: 'permissions.allow' is not an array; refusing to edit`);
    }
  }

  const allow = parsed.permissions?.allow ?? [];
  if (allow.includes(pattern)) {
    return { backupPath: null, alreadyInstalled: true, settingsPath };
  }

  let backupPath: string | null = null;
  if (raw) {
    backupPath = `${settingsPath}.bak.${timestampSlug()}`;
    writeFileSync(backupPath, raw);
  }
  if (!parsed.permissions) parsed.permissions = {};
  if (!Array.isArray(parsed.permissions.allow)) parsed.permissions.allow = [];
  parsed.permissions.allow.push(pattern);

  writeFileSync(settingsPath, `${JSON.stringify(parsed, null, 2)}\n`);
  return { backupPath, alreadyInstalled: false, settingsPath };
}

export type PermissionUninstallResult = {
  backupPath: string | null;
  removed: boolean;
  settingsPath: string;
};

export function uninstallPermission(
  pattern: string = BRACKISH_PERMISSION_PATTERN,
  home: string = claudeHome(),
): PermissionUninstallResult {
  const settingsPath = settingsJsonPath(home);
  if (!existsSync(settingsPath)) return { backupPath: null, removed: false, settingsPath };

  const raw = readFileSync(settingsPath, 'utf8');
  let parsed: ParsedSettings;
  try {
    parsed = parseSettings(raw);
  } catch (e) {
    throw new Error(
      `${settingsPath} is not valid JSON (${e instanceof Error ? e.message : e}); refusing to touch it`,
    );
  }
  const allow = parsed.permissions?.allow;
  if (!Array.isArray(allow) || !allow.includes(pattern)) {
    return { backupPath: null, removed: false, settingsPath };
  }
  const backupPath = `${settingsPath}.bak.${timestampSlug()}`;
  writeFileSync(backupPath, raw);

  const filtered = allow.filter((p) => p !== pattern);
  if (parsed.permissions) {
    if (filtered.length === 0) delete parsed.permissions.allow;
    else parsed.permissions.allow = filtered;
    if (Object.keys(parsed.permissions).length === 0) delete parsed.permissions;
  }
  writeFileSync(settingsPath, `${JSON.stringify(parsed, null, 2)}\n`);
  return { backupPath, removed: true, settingsPath };
}

// --- hook snippet (read-only) ---

export function hookSnippet(scriptPath: string): string {
  return JSON.stringify(
    {
      hooks: {
        UserPromptSubmit: [
          {
            matcher: '',
            hooks: [{ type: 'command', command: scriptPath }],
          },
        ],
      },
    },
    null,
    2,
  );
}

// --- helpers ---

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function countFilesRecursive(path: string): number {
  let n = 0;
  const stack = [path];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined) break;
    for (const e of readdirSync(cur, { withFileTypes: true })) {
      const full = join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else n++;
    }
  }
  return n;
}
