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
  bundledSkillDir,
  defaultSkillDest,
  hookSnippet,
  inspectInstall,
  installHook,
  installSkill,
  settingsJsonPath,
  uninstallHook,
  uninstallSkill,
} from '../src/install.js';

describe('install: paths', () => {
  const savedHome = process.env.CLAUDE_HOME;

  afterEach(() => {
    if (savedHome !== undefined) process.env.CLAUDE_HOME = savedHome;
    else delete process.env.CLAUDE_HOME;
  });

  it('CLAUDE_HOME env redirects skill/settings paths', () => {
    process.env.CLAUDE_HOME = '/tmp/elsewhere';
    expect(defaultSkillDest()).toBe('/tmp/elsewhere/skills/brackish');
    expect(settingsJsonPath()).toBe('/tmp/elsewhere/settings.json');
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

  it('creates settings.json when none exists', () => {
    const res = installHook(scriptPath);
    expect(res.backupPath).toBeNull();
    expect(res.alreadyInstalled).toBe(false);
    const parsed = JSON.parse(readFileSync(res.settingsPath, 'utf8')) as {
      hooks?: { UserPromptSubmit?: { command?: string }[] };
    };
    expect(parsed.hooks?.UserPromptSubmit?.[0]?.command).toBe(scriptPath);
  });

  it('preserves unrelated hook entries from other tools', () => {
    const settings = settingsJsonPath();
    mkdirSync(tmp, { recursive: true });
    writeFileSync(
      settings,
      JSON.stringify({
        hooks: {
          Stop: [{ type: 'command', command: '/other/tool/hook.sh' }],
          UserPromptSubmit: [{ type: 'command', command: '/another/prompt-hook.sh' }],
        },
      }),
    );
    installHook(scriptPath);
    const parsed = JSON.parse(readFileSync(settings, 'utf8')) as {
      hooks?: { Stop?: { command?: string }[]; UserPromptSubmit?: { command?: string }[] };
    };
    expect(parsed.hooks?.Stop?.[0]?.command).toBe('/other/tool/hook.sh');
    const upsCommands = parsed.hooks?.UserPromptSubmit?.map((h) => h.command);
    expect(upsCommands).toEqual(['/another/prompt-hook.sh', scriptPath]);
  });

  it('is idempotent: second install reports alreadyInstalled and writes no backup', () => {
    installHook(scriptPath);
    const second = installHook(scriptPath);
    expect(second.alreadyInstalled).toBe(true);
    expect(second.backupPath).toBeNull();
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
    expect(() => installHook(scriptPath)).toThrow(/refusing to edit/);
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

  it('removes our hook entry, preserves other-tool entries, writes backup', () => {
    const settings = settingsJsonPath();
    mkdirSync(tmp, { recursive: true });
    writeFileSync(
      settings,
      JSON.stringify({
        hooks: {
          Stop: [{ type: 'command', command: '/other/tool/hook.sh' }],
          UserPromptSubmit: [
            { type: 'command', command: '/another/prompt-hook.sh' },
            { type: 'command', command: scriptPath },
          ],
        },
      }),
    );
    const res = uninstallHook(scriptPath);
    expect(res.removed).toBe(true);
    expect(res.backupPath).not.toBeNull();
    const parsed = JSON.parse(readFileSync(settings, 'utf8')) as {
      hooks?: { Stop?: unknown[]; UserPromptSubmit?: { command?: string }[] };
    };
    expect(parsed.hooks?.Stop).toBeDefined();
    expect(parsed.hooks?.UserPromptSubmit?.map((h) => h.command)).toEqual([
      '/another/prompt-hook.sh',
    ]);
  });

  it('cleans up empty UserPromptSubmit + empty hooks keys after removal', () => {
    const settings = settingsJsonPath();
    mkdirSync(tmp, { recursive: true });
    writeFileSync(
      settings,
      JSON.stringify({
        hooks: { UserPromptSubmit: [{ type: 'command', command: scriptPath }] },
        otherTopLevel: 'preserved',
      }),
    );
    uninstallHook(scriptPath);
    const parsed = JSON.parse(readFileSync(settings, 'utf8')) as Record<string, unknown>;
    expect(parsed.hooks).toBeUndefined();
    expect(parsed.otherTopLevel).toBe('preserved');
  });

  it('is a no-op when we are not installed (no backup written)', () => {
    const settings = settingsJsonPath();
    mkdirSync(tmp, { recursive: true });
    writeFileSync(
      settings,
      JSON.stringify({ hooks: { UserPromptSubmit: [{ command: '/other.sh' }] } }),
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

describe('hookSnippet', () => {
  it('returns a JSON fragment that round-trips through JSON.parse', () => {
    const snip = hookSnippet('/path/to/script.sh');
    const parsed = JSON.parse(snip) as {
      hooks: { UserPromptSubmit: { type: string; command: string }[] };
    };
    expect(parsed.hooks.UserPromptSubmit[0]?.command).toBe('/path/to/script.sh');
    expect(parsed.hooks.UserPromptSubmit[0]?.type).toBe('command');
  });
});
