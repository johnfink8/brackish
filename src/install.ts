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

// --- paths ---

export function claudeHome(): string {
  return process.env.CLAUDE_HOME ?? join(homedir(), '.claude');
}

export function defaultSkillDest(): string {
  return join(claudeHome(), 'skills', 'brackish');
}

export function settingsJsonPath(): string {
  return join(claudeHome(), 'settings.json');
}

/** Locate the bundled skill/ directory. Works in dev (src/) and in an installed package (dist/). */
export function bundledSkillDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  // src/install.ts -> <root>/skill   (dev via tsx)
  // dist/cli.js   -> <root>/skill   (installed npm package)
  return resolve(dirname(thisFile), '..', 'skill');
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
  alreadyInstalled: boolean;
  otherHookCount: number;
};

export type InstallPlan = {
  skill: SkillInspection;
  hook: HookInspection;
};

type ParsedSettings = {
  hooks?: {
    UserPromptSubmit?: Array<{ type?: string; command?: string; [k: string]: unknown }>;
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

function parseSettings(raw: string): ParsedSettings {
  return JSON.parse(raw) as ParsedSettings;
}

export function inspectInstall(opts: { dest?: string } = {}): InstallPlan {
  const dest = opts.dest ?? defaultSkillDest();
  const scriptPath = join(dest, 'hooks', 'inbox-on-prompt.sh');
  const settingsPath = settingsJsonPath();

  const skill: SkillInspection = { destPath: dest, exists: existsSync(dest) };

  const settingsExists = existsSync(settingsPath);
  let settingsParseError: string | null = null;
  let alreadyInstalled = false;
  let otherHookCount = 0;

  if (settingsExists) {
    try {
      const parsed = parseSettings(readFileSync(settingsPath, 'utf8'));
      const hooks = Array.isArray(parsed.hooks?.UserPromptSubmit)
        ? parsed.hooks.UserPromptSubmit
        : [];
      alreadyInstalled = hooks.some((h) => h.command === scriptPath);
      otherHookCount = hooks.filter((h) => h.command !== scriptPath).length;
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
      otherHookCount,
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

/** Add `{ type: 'command', command: scriptPath }` to hooks.UserPromptSubmit[] in settings.json.
 *  Backs up the existing file first; idempotent (detects an existing entry with the same command). */
export function installHook(scriptPath: string): HookInstallResult {
  const settingsPath = settingsJsonPath();
  mkdirSync(dirname(settingsPath), { recursive: true });

  let parsed: ParsedSettings = {};
  let backupPath: string | null = null;

  if (existsSync(settingsPath)) {
    const raw = readFileSync(settingsPath, 'utf8');
    try {
      parsed = parseSettings(raw);
    } catch (e) {
      throw new Error(
        `${settingsPath} is not valid JSON (${e instanceof Error ? e.message : e}); refusing to touch it`,
      );
    }
    // Validate shape: if hooks exists, it must be an object; if UserPromptSubmit exists, it must be array.
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
    const hooks = (parsed.hooks?.UserPromptSubmit ?? []) as Array<{ command?: string }>;
    if (hooks.some((h) => h.command === scriptPath)) {
      return { backupPath: null, alreadyInstalled: true, settingsPath };
    }
    // We're about to modify — back up the original first.
    backupPath = `${settingsPath}.bak.${timestampSlug()}`;
    writeFileSync(backupPath, raw);
  }

  if (!parsed.hooks) parsed.hooks = {};
  if (!Array.isArray(parsed.hooks.UserPromptSubmit)) parsed.hooks.UserPromptSubmit = [];
  parsed.hooks.UserPromptSubmit.push({ type: 'command', command: scriptPath });

  writeFileSync(settingsPath, `${JSON.stringify(parsed, null, 2)}\n`);
  return { backupPath, alreadyInstalled: false, settingsPath };
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

export function uninstallHook(scriptPath: string): HookUninstallResult {
  const settingsPath = settingsJsonPath();
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
  const hooks = parsed.hooks?.UserPromptSubmit;
  if (!Array.isArray(hooks)) return { backupPath: null, removed: false, settingsPath };

  const filtered = hooks.filter((h) => h.command !== scriptPath);
  if (filtered.length === hooks.length) {
    return { backupPath: null, removed: false, settingsPath };
  }

  const backupPath = `${settingsPath}.bak.${timestampSlug()}`;
  writeFileSync(backupPath, raw);

  if (filtered.length === 0 && parsed.hooks) {
    delete parsed.hooks.UserPromptSubmit;
    if (Object.keys(parsed.hooks).length === 0) {
      delete parsed.hooks;
    }
  } else if (parsed.hooks) {
    parsed.hooks.UserPromptSubmit = filtered;
  }
  writeFileSync(settingsPath, `${JSON.stringify(parsed, null, 2)}\n`);
  return { backupPath, removed: true, settingsPath };
}

// --- hook snippet (read-only) ---

export function hookSnippet(scriptPath: string): string {
  return JSON.stringify(
    {
      hooks: {
        UserPromptSubmit: [{ type: 'command', command: scriptPath }],
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
