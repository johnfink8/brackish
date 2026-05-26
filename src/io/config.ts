// Config load/save for both the client and server flavors.
//
// Precedence (highest to lowest):
//   1. explicit CLI flag (applied at the call site, not here)
//   2. env var (BRACKISH_SOCKET, BRACKISH_SERVER, BRACKISH_TOKEN, BRACKISH_IDENTITY, BRACKISH_HOME)
//   3. project file: ./.brackish.toml
//   4. home file:    ~/.brackish/config.toml  (or $BRACKISH_HOME/config.toml)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { z } from 'zod';
import { IdentitySchema, TokenSchema } from '../lib/models.js';

// --- paths ---

export function brackishHome(): string {
  return process.env.BRACKISH_HOME ?? join(homedir(), '.brackish');
}

export function defaultSocketPath(): string {
  return join(brackishHome(), 'brackish.sock');
}

export function defaultDataPath(): string {
  return join(brackishHome(), 'brackish.db');
}

export function defaultClientConfigPath(): string {
  return join(brackishHome(), 'config.toml');
}

export function defaultServerConfigPath(): string {
  return join(brackishHome(), 'server.toml');
}

function projectClientConfigPath(): string {
  return join(process.cwd(), '.brackish.toml');
}

export function ensureBrackishHome(): string {
  const home = brackishHome();
  if (!existsSync(home)) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
  }
  return home;
}

// --- client config ---

// Internal TOML shape uses snake_case keys; the in-memory shape uses camelCase.
const ClientConfigFileSchema = z.object({
  identity: IdentitySchema.optional(),
  socket_path: z.string().optional(),
  server: z.string().url().optional(),
  token: TokenSchema.optional(),
});

const ClientConfigSchema = z.object({
  identity: IdentitySchema,
  socketPath: z.string().optional(),
  server: z.string().url().optional(),
  token: TokenSchema.optional(),
});
export type ClientConfig = z.infer<typeof ClientConfigSchema>;

function readTomlIfExists(path: string): unknown {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8');
  return parseToml(raw);
}

/** Load + merge client config from file + env. Throws if `identity` is missing after merge. */
export function loadClientConfig(opts: { explicitPath?: string | undefined } = {}): ClientConfig {
  const filePath =
    opts.explicitPath ??
    (existsSync(projectClientConfigPath()) ? projectClientConfigPath() : defaultClientConfigPath());
  const fromFile = ClientConfigFileSchema.parse(readTomlIfExists(filePath));

  const merged = {
    identity: process.env.BRACKISH_IDENTITY ?? fromFile.identity,
    socketPath: process.env.BRACKISH_SOCKET ?? fromFile.socket_path,
    server: process.env.BRACKISH_SERVER ?? fromFile.server,
    token: process.env.BRACKISH_TOKEN ?? fromFile.token,
  };

  return ClientConfigSchema.parse(merged);
}

/** Write client config to a TOML file (default: ~/.brackish/config.toml). Creates the dir. */
export function saveClientConfig(
  cfg: ClientConfig,
  path: string = defaultClientConfigPath(),
): void {
  ensureBrackishHome();
  const fileShape: Record<string, string> = {
    identity: cfg.identity,
  };
  if (cfg.socketPath !== undefined) fileShape.socket_path = cfg.socketPath;
  if (cfg.server !== undefined) fileShape.server = cfg.server;
  if (cfg.token !== undefined) fileShape.token = cfg.token;
  writeFileSync(path, stringifyToml(fileShape), { mode: 0o600 });
}

// --- server config ---

const ServerConfigFileSchema = z.object({
  socket_path: z.string().optional(),
  bind: z.string().optional(),
  data_path: z.string().optional(),
});

const ServerConfigSchema = z.object({
  socketPath: z.string(),
  bind: z.string().optional(),
  dataPath: z.string(),
});
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

/** Load server config, applying defaults for omitted fields. */
export function loadServerConfig(opts: { explicitPath?: string | undefined } = {}): ServerConfig {
  const filePath = opts.explicitPath ?? defaultServerConfigPath();
  const fromFile = ServerConfigFileSchema.parse(readTomlIfExists(filePath));
  const merged = {
    socketPath: fromFile.socket_path ?? defaultSocketPath(),
    bind: fromFile.bind,
    dataPath: fromFile.data_path ?? defaultDataPath(),
  };
  return ServerConfigSchema.parse(merged);
}

export function saveServerConfig(
  cfg: ServerConfig,
  path: string = defaultServerConfigPath(),
): void {
  ensureBrackishHome();
  const fileShape: Record<string, string> = {
    socket_path: cfg.socketPath,
    data_path: cfg.dataPath,
  };
  if (cfg.bind !== undefined) fileShape.bind = cfg.bind;
  writeFileSync(path, stringifyToml(fileShape), { mode: 0o600 });
}

// --- bind-address parsing ---

/** Default TCP port used when --bind is given without one (e.g. `--bind 0.0.0.0` → 0.0.0.0:11442). */
const DEFAULT_BIND_PORT = 11442;

/** Default `--bind` value used when the flag is passed alone (e.g. `--bind` → 127.0.0.1:11442).
 *  Loopback-only — pass `--bind 0.0.0.0` explicitly to expose on the LAN. */
const DEFAULT_BIND_ADDR = `127.0.0.1:${DEFAULT_BIND_PORT}`;

/**
 * Parse a bind spec into structured form. Accepts:
 *   "host:port"   → exact
 *   ":port"       → 127.0.0.1:port            (loopback shortcut)
 *   "host"        → host:DEFAULT_BIND_PORT    (default port)
 *   ""            → DEFAULT_BIND_ADDR
 */
export function parseBindAddress(bind: string): { host: string; port: number } {
  if (bind === '') return parseBindAddress(DEFAULT_BIND_ADDR);
  if (!bind.includes(':')) return parseBindAddress(`${bind}:${DEFAULT_BIND_PORT}`);

  const idx = bind.lastIndexOf(':');
  const host = idx === 0 ? '127.0.0.1' : bind.slice(0, idx);
  const portStr = bind.slice(idx + 1);
  const port = Number.parseInt(portStr, 10);
  if (!Number.isFinite(port) || port < 0 || port > 65535) {
    throw new Error(`invalid port in bind address "${bind}"`);
  }
  return { host, port };
}
