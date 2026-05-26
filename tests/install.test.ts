import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bundledSkillDir,
  claudeHome,
  defaultSkillDest,
  installSkill,
  projectClaudeHome,
  uninstallSkill,
  userClaudeHome,
} from '../src/io/install.js';

describe('install: paths', () => {
  const savedHome = process.env.CLAUDE_HOME;

  afterEach(() => {
    if (savedHome !== undefined) process.env.CLAUDE_HOME = savedHome;
    else delete process.env.CLAUDE_HOME;
  });

  it('CLAUDE_HOME env redirects the user-scope skill path', () => {
    process.env.CLAUDE_HOME = '/tmp/elsewhere';
    expect(userClaudeHome()).toBe('/tmp/elsewhere');
    expect(defaultSkillDest()).toBe('/tmp/elsewhere/skills/brackish');
  });

  it('project scope resolves to <cwd>/.claude regardless of CLAUDE_HOME', () => {
    process.env.CLAUDE_HOME = '/tmp/elsewhere';
    const home = claudeHome('project', '/some/project/dir');
    expect(home).toBe('/some/project/dir/.claude');
    expect(projectClaudeHome('/some/project/dir')).toBe('/some/project/dir/.claude');
    expect(defaultSkillDest(home)).toBe('/some/project/dir/.claude/skills/brackish');
  });

  it('bundledSkillDir resolves to <repo>/skill', () => {
    const path = bundledSkillDir();
    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(path, 'SKILL.md'))).toBe(true);
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

  it('copies the bundled skill (incl. SKILL.md) into the dest', () => {
    const res = installSkill(defaultSkillDest());
    expect(res.wroteFiles).toBeGreaterThan(0);
    expect(existsSync(join(defaultSkillDest(), 'SKILL.md'))).toBe(true);
  });

  it('never writes a settings.json (install only touches the skill dir)', () => {
    installSkill(defaultSkillDest());
    expect(existsSync(join(tmp, 'settings.json'))).toBe(false);
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
    // Nothing under the sentinel user home was created.
    expect(existsSync(join(tmp, 'NOT-THIS-ONE'))).toBe(false);

    expect(uninstallSkill(dest)).toBe(true);
    expect(existsSync(dest)).toBe(false);
  });
});
