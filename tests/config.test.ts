import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  brackishHome,
  defaultClientConfigPath,
  defaultDataPath,
  defaultSocketPath,
  ensureBrackishHome,
  loadClientConfig,
  loadServerConfig,
  parseBindAddress,
  saveClientConfig,
  saveServerConfig,
} from '../src/config.js';

describe('config paths', () => {
  let tmp: string;
  const savedHome = process.env.BRACKISH_HOME;
  const savedIdentity = process.env.BRACKISH_IDENTITY;
  const savedSocket = process.env.BRACKISH_SOCKET;
  const savedServer = process.env.BRACKISH_SERVER;
  const savedToken = process.env.BRACKISH_TOKEN;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'brackish-cfg-'));
    process.env.BRACKISH_HOME = tmp;
    delete process.env.BRACKISH_IDENTITY;
    delete process.env.BRACKISH_SOCKET;
    delete process.env.BRACKISH_SERVER;
    delete process.env.BRACKISH_TOKEN;
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (savedHome !== undefined) process.env.BRACKISH_HOME = savedHome;
    else delete process.env.BRACKISH_HOME;
    if (savedIdentity !== undefined) process.env.BRACKISH_IDENTITY = savedIdentity;
    if (savedSocket !== undefined) process.env.BRACKISH_SOCKET = savedSocket;
    if (savedServer !== undefined) process.env.BRACKISH_SERVER = savedServer;
    if (savedToken !== undefined) process.env.BRACKISH_TOKEN = savedToken;
  });

  it('brackishHome respects BRACKISH_HOME env', () => {
    expect(brackishHome()).toBe(tmp);
  });

  it('defaultSocketPath / DataPath / ClientConfigPath all live under BRACKISH_HOME', () => {
    expect(defaultSocketPath()).toBe(join(tmp, 'brackish.sock'));
    expect(defaultDataPath()).toBe(join(tmp, 'brackish.db'));
    expect(defaultClientConfigPath()).toBe(join(tmp, 'config.toml'));
  });

  it('ensureBrackishHome creates the dir with 0700', () => {
    rmSync(tmp, { recursive: true, force: true });
    ensureBrackishHome();
    expect(existsSync(tmp)).toBe(true);
  });

  describe('client config', () => {
    it('save + load round-trip (socket-trust shape)', () => {
      saveClientConfig({
        identity: 'frontend',
        socketPath: '/var/tmp/brackish.sock',
      });
      const loaded = loadClientConfig();
      expect(loaded.identity).toBe('frontend');
      expect(loaded.socketPath).toBe('/var/tmp/brackish.sock');
      expect(loaded.server).toBeUndefined();
      expect(loaded.token).toBeUndefined();
    });

    it('save + load round-trip (cross-machine shape)', () => {
      saveClientConfig({
        identity: 'frontend',
        server: 'http://127.0.0.1:11442',
        token: 'a'.repeat(32),
      });
      const loaded = loadClientConfig();
      expect(loaded.server).toBe('http://127.0.0.1:11442');
      expect(loaded.token).toBe('a'.repeat(32));
    });

    it('env vars override file contents', () => {
      saveClientConfig({ identity: 'fromfile', socketPath: '/file/sock' });
      process.env.BRACKISH_IDENTITY = 'fromenv';
      process.env.BRACKISH_SOCKET = '/env/sock';
      const loaded = loadClientConfig();
      expect(loaded.identity).toBe('fromenv');
      expect(loaded.socketPath).toBe('/env/sock');
    });

    it('env-only is sufficient (no file present)', () => {
      process.env.BRACKISH_IDENTITY = 'frontend';
      process.env.BRACKISH_SOCKET = '/some/sock';
      const loaded = loadClientConfig();
      expect(loaded.identity).toBe('frontend');
      expect(loaded.socketPath).toBe('/some/sock');
    });

    it('throws cleanly when identity is missing', () => {
      expect(() => loadClientConfig()).toThrow();
    });

    it('project .brackish.toml takes precedence over home config', () => {
      const projectFile = join(process.cwd(), '.brackish.toml');
      writeFileSync(projectFile, 'identity = "fromproject"\nsocket_path = "/proj/sock"\n');
      try {
        // Also write a home config — should be ignored when project file exists.
        saveClientConfig({ identity: 'fromhome', socketPath: '/home/sock' });
        const loaded = loadClientConfig();
        expect(loaded.identity).toBe('fromproject');
        expect(loaded.socketPath).toBe('/proj/sock');
      } finally {
        rmSync(projectFile, { force: true });
      }
    });

    it('rejects an identity that fails validation', () => {
      saveClientConfig({ identity: 'frontend', socketPath: '/s' });
      process.env.BRACKISH_IDENTITY = 'NOT-VALID';
      expect(() => loadClientConfig()).toThrow();
    });
  });

  describe('server config', () => {
    it('returns sensible defaults when no file exists', () => {
      const loaded = loadServerConfig();
      expect(loaded.socketPath).toBe(defaultSocketPath());
      expect(loaded.dataPath).toBe(defaultDataPath());
      expect(loaded.bind).toBeUndefined();
    });

    it('save + load round-trip with bind set', () => {
      saveServerConfig({
        socketPath: '/var/brackish.sock',
        dataPath: '/var/brackish.db',
        bind: '0.0.0.0:11442',
      });
      const loaded = loadServerConfig();
      expect(loaded.socketPath).toBe('/var/brackish.sock');
      expect(loaded.dataPath).toBe('/var/brackish.db');
      expect(loaded.bind).toBe('0.0.0.0:11442');
    });
  });
});

describe('parseBindAddress', () => {
  it('parses host:port', () => {
    expect(parseBindAddress('127.0.0.1:11442')).toEqual({ host: '127.0.0.1', port: 11442 });
  });

  it('parses 0.0.0.0:port for any-interface bind', () => {
    expect(parseBindAddress('0.0.0.0:8080')).toEqual({ host: '0.0.0.0', port: 8080 });
  });

  it('defaults host to 127.0.0.1 when only :port is given', () => {
    expect(parseBindAddress(':9000')).toEqual({ host: '127.0.0.1', port: 9000 });
  });

  it('rejects bind without colon', () => {
    expect(() => parseBindAddress('11442')).toThrow();
  });

  it('rejects out-of-range port', () => {
    expect(() => parseBindAddress(':99999')).toThrow();
  });
});
