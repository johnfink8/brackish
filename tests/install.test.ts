import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BRACKISH_PERMISSION_PATTERN,
  bundledSkillDir,
  claudeHome,
  defaultSkillDest,
  hookSnippet,
  inspectInstall,
  installHook,
  installPermission,
  installSkill,
  projectClaudeHome,
  settingsJsonPath,
  uninstallHook,
  uninstallPermission,
  uninstallSkill,
  userClaudeHome,
} from '../src/io/install.js';

describe('install: paths', () => {
  const savedHome = process.env.CLAUDE_HOME;

  afterEach(() => {
    if (savedHome !== undefined) process.env.CLAUDE_HOME = savedHome;
    else delete process.env.CLAUDE_HOME;
  });

  it('CLAUDE_HOME env redirects user-scope skill/settings paths', () => {
    process.env.CLAUDE_HOME = '/tmp/elsewhere';
    expect(userClaudeHome()).toBe('/tmp/elsewhere');
    expect(defaultSkillDest()).toBe('/tmp/elsewhere/skills/brackish');
    expect(settingsJsonPath()).toBe('/tmp/elsewhere/settings.json');
  });

  it('project scope resolves to <cwd>/.claude regardless of CLAUDE_HOME', () => {
    process.env.CLAUDE_HOME = '/tmp/elsewhere';
    const home = claudeHome('project', '/some/project/dir');
    expect(home).toBe('/some/project/dir/.claude');
    expect(projectClaudeHome('/some/project/dir')).toBe('/some/project/dir/.claude');
    expect(defaultSkillDest(home)).toBe('/some/project/dir/.claude/skills/brackish');
    expect(settingsJsonPath(home)).toBe('/some/project/dir/.claude/settings.json');
  });

  it('bundledSkillDir resolves to <repo>/skill', () => {
    const path = bundledSkillDir();
    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(path, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(path, 'hooks', 'inbox-on-prompt.sh'))).toBe(true);
  });
});

describe('install: skill (copy)', () => {
  let tmp: string;
  const savedHome = process.env.CLAUDE_HOME;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'brackish-install-'));
    process.env.CLAUDE_HOME = tmp;
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (savedHome !== undefined) process.env.CLAUDE_HOME = savedHome;
    else delete process.env.CLAUDE_HOME;
  });

  it('copies SKILL.md and hooks/ into the dest, chmod +x on the hook', () => {
    const res = installSkill(defaultSkillDest());
    expect(res.wroteFiles).toBeGreaterThan(0);
    const dest = defaultSkillDest();
    expect(existsSync(join(dest, 'SKILL.md'))).toBe(true);
    const hook = join(dest, 'hooks', 'inbox-on-prompt.sh');
    expect(existsSync(hook)).toBe(true);
    expect(statSync(hook).mode & 0o111).not.toBe(0); // some exec bit
  });

  it('refuses to overwrite without --force', () => {
    installSkill(defaultSkillDest());
    expect(() => installSkill(defaultSkillDest())).toThrow(/already exists/);
  });

  it('overwrites when --force is set', () => {
    installSkill(defaultSkillDest());
    expect(() => installSkill(defaultSkillDest(), { force: true })).not.toThrow();
  });
});

describe('install: hook (settings.json merge)', () => {
  let tmp: string;
  let scriptPath: string;
  const savedHome = process.env.CLAUDE_HOME;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'brackish-hookcfg-'));
    process.env.CLAUDE_HOME = tmp;
    scriptPath = join(tmp, 'skills', 'brackish', 'hooks', 'inbox-on-prompt.sh');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (savedHome !== undefined) process.env.CLAUDE_HOME = savedHome;
    else delete process.env.CLAUDE_HOME;
  });

  type WrappedSettings = {
    hooks?: {
      Stop?: Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>;
      UserPromptSubmit?: Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>;
    };
  };

  it('creates settings.json with the matcher+hooks wrapper that Claude Code requires', () => {
    const res = installHook(scriptPath);
    expect(res.backupPath).toBeNull();
    expect(res.alreadyInstalled).toBe(false);
    const parsed = JSON.parse(readFileSync(res.settingsPath, 'utf8')) as WrappedSettings;
    const group = parsed.hooks?.UserPromptSubmit?.[0];
    expect(group?.matcher).toBe('');
    expect(group?.hooks?.[0]?.command).toBe(scriptPath);
  });

  it('preserves unrelated hook entries from other tools', () => {
    const settings = settingsJsonPath();
    mkdirSync(tmp, { recursive: true });
    writeFileSync(
      settings,
      JSON.stringify({
        hooks: {
          Stop: [{ matcher: 'Edit', hooks: [{ type: 'command', command: '/other/tool/hook.sh' }] }],
          UserPromptSubmit: [
            { matcher: '', hooks: [{ type: 'command', command: '/another/prompt-hook.sh' }] },
          ],
        },
      }),
    );
    installHook(scriptPath);
    const parsed = JSON.parse(readFileSync(settings, 'utf8')) as WrappedSettings;
    expect(parsed.hooks?.Stop?.[0]?.hooks?.[0]?.command).toBe('/other/tool/hook.sh');
    const upsCommands = (parsed.hooks?.UserPromptSubmit ?? []).flatMap(
      (g) => g.hooks?.map((h) => h.command) ?? [],
    );
    expect(upsCommands).toEqual(['/another/prompt-hook.sh', scriptPath]);
  });

  it('is idempotent: second install reports alreadyInstalled and writes no backup', () => {
    installHook(scriptPath);
    const second = installHook(scriptPath);
    expect(second.alreadyInstalled).toBe(true);
    expect(second.backupPath).toBeNull();
  });

  it('migrates a pre-existing bare-handler entry from older brackish releases', () => {
    const settings = settingsJsonPath();
    mkdirSync(tmp, { recursive: true });
    // Old-shape entry written by a previous brackish version — invalid per Claude Code's schema.
    writeFileSync(
      settings,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ type: 'command', command: scriptPath }],
        },
      }),
    );
    const res = installHook(scriptPath);
    expect(res.alreadyInstalled).toBe(false);
    expect(res.backupPath).not.toBeNull();
    const parsed = JSON.parse(readFileSync(settings, 'utf8')) as WrappedSettings;
    const group = parsed.hooks?.UserPromptSubmit?.[0];
    expect(group?.matcher).toBe('');
    expect(group?.hooks?.[0]?.command).toBe(scriptPath);
    expect(parsed.hooks?.UserPromptSubmit).toHaveLength(1);
  });

  it('writes a timestamped backup when modifying an existing file', () => {
    const settings = settingsJsonPath();
    mkdirSync(tmp, { recursive: true });
    writeFileSync(settings, JSON.stringify({ unrelated: 'stuff' }));
    const res = installHook(scriptPath);
    expect(res.backupPath).not.toBeNull();
    if (res.backupPath) {
      expect(existsSync(res.backupPath)).toBe(true);
      const backup = JSON.parse(readFileSync(res.backupPath, 'utf8')) as { unrelated?: string };
      expect(backup.unrelated).toBe('stuff');
    }
  });

  it('bails loudly on malformed settings.json (no edits, no backup)', () => {
    const settings = settingsJsonPath();
    mkdirSync(tmp, { recursive: true });
    writeFileSync(settings, '{ not: valid json');
    expect(() => installHook(scriptPath)).toThrow(/not valid JSON/);
    // Original file is untouched, no .bak files written
    expect(readFileSync(settings, 'utf8')).toBe('{ not: valid json');
  });

  it('bails when hooks key is not an object', () => {
    const settings = settingsJsonPath();
    mkdirSync(tmp, { recursive: true });
    writeFileSync(settings, JSON.stringify({ hooks: 'not-an-object' }));
    // Zod parse at the schema-validation step refuses; either message is acceptable as a refusal.
    expect(() => installHook(scriptPath)).toThrow(/refusing to (edit|touch it)/);
  });
});

describe('uninstall: hook', () => {
  let tmp: string;
  let scriptPath: string;
  const savedHome = process.env.CLAUDE_HOME;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'brackish-uninstall-'));
    process.env.CLAUDE_HOME = tmp;
    scriptPath = join(tmp, 'skills', 'brackish', 'hooks', 'inbox-on-prompt.sh');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (savedHome !== undefined) process.env.CLAUDE_HOME = savedHome;
    else delete process.env.CLAUDE_HOME;
  });

  type WrappedSettings = {
    hooks?: {
      Stop?: Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>;
      UserPromptSubmit?: Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>;
    };
    otherTopLevel?: string;
  };

  it('removes our hook entry, preserves other-tool entries, writes backup', () => {
    const settings = settingsJsonPath();
    mkdirSync(tmp, { recursive: true });
    writeFileSync(
      settings,
      JSON.stringify({
        hooks: {
          Stop: [{ matcher: 'Edit', hooks: [{ type: 'command', command: '/other/tool/hook.sh' }] }],
          UserPromptSubmit: [
            { matcher: '', hooks: [{ type: 'command', command: '/another/prompt-hook.sh' }] },
            { matcher: '', hooks: [{ type: 'command', command: scriptPath }] },
          ],
        },
      }),
    );
    const res = uninstallHook(scriptPath);
    expect(res.removed).toBe(true);
    expect(res.backupPath).not.toBeNull();
    const parsed = JSON.parse(readFileSync(settings, 'utf8')) as WrappedSettings;
    expect(parsed.hooks?.Stop?.[0]?.hooks?.[0]?.command).toBe('/other/tool/hook.sh');
    const upsCommands = (parsed.hooks?.UserPromptSubmit ?? []).flatMap(
      (g) => g.hooks?.map((h) => h.command) ?? [],
    );
    expect(upsCommands).toEqual(['/another/prompt-hook.sh']);
  });

  it('cleans up empty UserPromptSubmit + empty hooks keys after removal', () => {
    const settings = settingsJsonPath();
    mkdirSync(tmp, { recursive: true });
    writeFileSync(
      settings,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: scriptPath }] }],
        },
        otherTopLevel: 'preserved',
      }),
    );
    uninstallHook(scriptPath);
    const parsed = JSON.parse(readFileSync(settings, 'utf8')) as WrappedSettings;
    expect(parsed.hooks).toBeUndefined();
    expect(parsed.otherTopLevel).toBe('preserved');
  });

  it('also removes an old bare-handler entry left over from a pre-fix install', () => {
    const settings = settingsJsonPath();
    mkdirSync(tmp, { recursive: true });
    writeFileSync(
      settings,
      JSON.stringify({
        hooks: { UserPromptSubmit: [{ type: 'command', command: scriptPath }] },
      }),
    );
    const res = uninstallHook(scriptPath);
    expect(res.removed).toBe(true);
    const parsed = JSON.parse(readFileSync(settings, 'utf8')) as WrappedSettings;
    expect(parsed.hooks).toBeUndefined();
  });

  it('is a no-op when we are not installed (no backup written)', () => {
    const settings = settingsJsonPath();
    mkdirSync(tmp, { recursive: true });
    writeFileSync(
      settings,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: '/other.sh' }] }],
        },
      }),
    );
    const res = uninstallHook(scriptPath);
    expect(res.removed).toBe(false);
    expect(res.backupPath).toBeNull();
  });
});

describe('uninstall: skill', () => {
  let tmp: string;
  const savedHome = process.env.CLAUDE_HOME;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'brackish-skill-uninstall-'));
    process.env.CLAUDE_HOME = tmp;
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (savedHome !== undefined) process.env.CLAUDE_HOME = savedHome;
    else delete process.env.CLAUDE_HOME;
  });

  it('removes the skill dir', () => {
    installSkill(defaultSkillDest());
    expect(existsSync(defaultSkillDest())).toBe(true);
    expect(uninstallSkill(defaultSkillDest())).toBe(true);
    expect(existsSync(defaultSkillDest())).toBe(false);
  });

  it('returns false when not installed', () => {
    expect(uninstallSkill(defaultSkillDest())).toBe(false);
  });
});

describe('inspectInstall', () => {
  let tmp: string;
  const savedHome = process.env.CLAUDE_HOME;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'brackish-inspect-'));
    process.env.CLAUDE_HOME = tmp;
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (savedHome !== undefined) process.env.CLAUDE_HOME = savedHome;
    else delete process.env.CLAUDE_HOME;
  });

  it('reports skill.exists=false and hook.alreadyInstalled=false on a fresh CLAUDE_HOME', () => {
    const plan = inspectInstall();
    expect(plan.skill.exists).toBe(false);
    expect(plan.hook.settingsExists).toBe(false);
    expect(plan.hook.alreadyInstalled).toBe(false);
  });

  it('reports alreadyInstalled=true after installHook', () => {
    const scriptPath = join(defaultSkillDest(), 'hooks', 'inbox-on-prompt.sh');
    installHook(scriptPath);
    const plan = inspectInstall();
    expect(plan.hook.alreadyInstalled).toBe(true);
  });

  it('reports settingsParseError on malformed file', () => {
    mkdirSync(tmp, { recursive: true });
    writeFileSync(settingsJsonPath(), 'bogus');
    const plan = inspectInstall();
    expect(plan.hook.settingsParseError).not.toBeNull();
  });
});

describe('install: project scope', () => {
  let tmp: string;
  const savedHome = process.env.CLAUDE_HOME;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'brackish-project-'));
    // Ensure user scope can't accidentally satisfy the test if home resolution is wrong.
    process.env.CLAUDE_HOME = join(tmp, 'NOT-THIS-ONE');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (savedHome !== undefined) process.env.CLAUDE_HOME = savedHome;
    else delete process.env.CLAUDE_HOME;
  });

  it('install + uninstall use <project>/.claude when scope=project', () => {
    const home = claudeHome('project', tmp);
    expect(home).toBe(join(tmp, '.claude'));

    const dest = defaultSkillDest(home);
    const r1 = installSkill(dest);
    expect(r1.destPath).toBe(join(tmp, '.claude', 'skills', 'brackish'));
    expect(existsSync(r1.destPath)).toBe(true);

    const scriptPath = join(dest, 'hooks', 'inbox-on-prompt.sh');
    const r2 = installHook(scriptPath, home);
    expect(r2.settingsPath).toBe(join(tmp, '.claude', 'settings.json'));
    expect(existsSync(r2.settingsPath)).toBe(true);

    // The user-scoped path was NOT touched (we redirected CLAUDE_HOME to a separate sentinel).
    expect(existsSync(settingsJsonPath())).toBe(false);

    const plan = inspectInstall({ home });
    expect(plan.skill.exists).toBe(true);
    expect(plan.hook.alreadyInstalled).toBe(true);

    expect(uninstallHook(scriptPath, home).removed).toBe(true);
    expect(uninstallSkill(dest)).toBe(true);
  });
});

describe('install/uninstall: permission allow-rule', () => {
  let tmp: string;
  const savedHome = process.env.CLAUDE_HOME;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'brackish-perm-'));
    process.env.CLAUDE_HOME = tmp;
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (savedHome !== undefined) process.env.CLAUDE_HOME = savedHome;
    else delete process.env.CLAUDE_HOME;
  });

  type WithPerms = { permissions?: { allow?: string[]; deny?: string[] } };

  it('creates settings.json with the allow rule when none exists', () => {
    const res = installPermission();
    expect(res.backupPath).toBeNull();
    expect(res.alreadyInstalled).toBe(false);
    const parsed = JSON.parse(readFileSync(res.settingsPath, 'utf8')) as WithPerms;
    expect(parsed.permissions?.allow).toEqual([BRACKISH_PERMISSION_PATTERN]);
  });

  it('preserves unrelated permissions and merges', () => {
    const settings = settingsJsonPath();
    mkdirSync(tmp, { recursive: true });
    writeFileSync(
      settings,
      JSON.stringify({
        permissions: { allow: ['Bash(npm run *)', 'Read(*.md)'], deny: ['Bash(rm *)'] },
      }),
    );
    installPermission();
    const parsed = JSON.parse(readFileSync(settings, 'utf8')) as WithPerms;
    expect(parsed.permissions?.allow).toEqual([
      'Bash(npm run *)',
      'Read(*.md)',
      BRACKISH_PERMISSION_PATTERN,
    ]);
    expect(parsed.permissions?.deny).toEqual(['Bash(rm *)']);
  });

  it('is idempotent', () => {
    installPermission();
    const second = installPermission();
    expect(second.alreadyInstalled).toBe(true);
    expect(second.backupPath).toBeNull();
  });

  it('inspectInstall reports permission state', () => {
    let plan = inspectInstall();
    expect(plan.permission.alreadyInstalled).toBe(false);
    installPermission();
    plan = inspectInstall();
    expect(plan.permission.alreadyInstalled).toBe(true);
    expect(plan.permission.pattern).toBe(BRACKISH_PERMISSION_PATTERN);
  });

  it('uninstallPermission removes only ours; preserves other entries', () => {
    const settings = settingsJsonPath();
    mkdirSync(tmp, { recursive: true });
    writeFileSync(
      settings,
      JSON.stringify({
        permissions: { allow: ['Bash(npm run *)', BRACKISH_PERMISSION_PATTERN] },
      }),
    );
    const res = uninstallPermission();
    expect(res.removed).toBe(true);
    const parsed = JSON.parse(readFileSync(settings, 'utf8')) as WithPerms;
    expect(parsed.permissions?.allow).toEqual(['Bash(npm run *)']);
  });

  it('uninstallPermission cleans up empty allow + empty permissions', () => {
    const settings = settingsJsonPath();
    mkdirSync(tmp, { recursive: true });
    writeFileSync(
      settings,
      JSON.stringify({ permissions: { allow: [BRACKISH_PERMISSION_PATTERN] } }),
    );
    uninstallPermission();
    const parsed = JSON.parse(readFileSync(settings, 'utf8')) as Record<string, unknown>;
    expect(parsed.permissions).toBeUndefined();
  });

  it('uninstallPermission is a no-op when not present', () => {
    const settings = settingsJsonPath();
    mkdirSync(tmp, { recursive: true });
    writeFileSync(settings, JSON.stringify({ permissions: { allow: ['Bash(npm run *)'] } }));
    const res = uninstallPermission();
    expect(res.removed).toBe(false);
    expect(res.backupPath).toBeNull();
  });
});

describe('hookSnippet', () => {
  it('returns a matcher+hooks wrapped fragment that round-trips through JSON.parse', () => {
    const snip = hookSnippet('/path/to/script.sh');
    const parsed = JSON.parse(snip) as {
      hooks: {
        UserPromptSubmit: Array<{
          matcher?: string;
          hooks?: Array<{ type?: string; command?: string }>;
        }>;
      };
    };
    const group = parsed.hooks.UserPromptSubmit[0];
    expect(group?.matcher).toBe('');
    expect(group?.hooks?.[0]?.command).toBe('/path/to/script.sh');
    expect(group?.hooks?.[0]?.type).toBe('command');
  });
});
