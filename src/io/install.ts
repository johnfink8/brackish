// `brackish install` / `uninstall` machinery: copy (or remove) the bundled skill directory.
// That is the WHOLE job — brackish never edits the user's settings.json (no hooks, no permission
// rules). Sync is the foreground status/nap loop; the user opts into a `Bash(brackish *)` allow-rule
// themselves if they want fewer approval prompts.
//
// The only file we read for "bundled skill" is one we ship in the npm tarball, located at the
// package root via import.meta.url; works the same in dev and in installed packages.

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  return { wroteFiles: countFilesRecursive(destPath), destPath };
}

export function uninstallSkill(destPath: string): boolean {
  if (!existsSync(destPath)) return false;
  rmSync(destPath, { recursive: true, force: true });
  return true;
}

// --- helpers ---

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
