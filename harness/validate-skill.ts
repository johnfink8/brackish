// Validate the brackish skill's /brackish invite + /brackish connect flows with real Claudes,
// using the **shipping install path** — no inlined CLAUDE.md, no role briefing. Each side gets
// `brackish install --local --yes --permission` run in its working dir; Claude Code discovers the
// project-scope skill, the UserPromptSubmit hook, and the Bash(brackish *) allow-rule from
// `./.claude/`. Sub-Claudes are spawned with a single slash-command prompt; the skill must do
// the rest unaided.
//
// Run: `npx tsx harness/validate-skill.ts`

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

const PEER_NAME = 'client-claude';
const SERVER_BUDGET_USD = 1.5;
const CLIENT_BUDGET_USD = 1.5;
const TURN_TIMEOUT_MS = 300_000;

const ClaudeTurnSchema = z
  .object({
    result: z.string().optional(),
    total_cost_usd: z.number().optional(),
    duration_ms: z.number().optional(),
    num_turns: z.number().optional(),
  })
  .passthrough();

function stamp(): string {
  const d = new Date();
  const z2 = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${z2(d.getUTCMonth() + 1)}${z2(d.getUTCDate())}-${z2(d.getUTCHours())}${z2(d.getUTCMinutes())}${z2(d.getUTCSeconds())}`;
}

function ensureBuilt(): string {
  const distEntry = join(REPO_ROOT, 'dist', 'cli.js');
  if (!existsSync(distEntry)) {
    const r = spawnSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' });
    if (r.status !== 0) throw new Error('npm run build failed');
  }
  return distEntry;
}

function writeWrapperBin(binDir: string, distEntry: string): string {
  mkdirSync(binDir, { recursive: true });
  const wrapper = join(binDir, 'brackish');
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${distEntry}" "$@"\n`, {
    mode: 0o755,
  });
  chmodSync(wrapper, 0o755);
  return wrapper;
}

type TurnResult = { stdout: string; stderr: string; data: z.infer<typeof ClaudeTurnSchema> };

async function runClaude(args: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  prompt: string;
  budgetUsd: number;
  transcriptPath: string;
}): Promise<TurnResult> {
  const claudeArgs = [
    '--print',
    '--permission-mode',
    'bypassPermissions',
    '--allowedTools',
    'Bash',
    '--output-format',
    'json',
    '--no-session-persistence',
    '--no-chrome',
    '--max-budget-usd',
    String(args.budgetUsd),
    args.prompt,
  ];
  const child: ChildProcess = spawn('claude', claudeArgs, {
    cwd: args.cwd,
    env: args.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (d) => {
    stdout += d.toString();
  });
  child.stderr?.on('data', (d) => {
    stderr += d.toString();
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5000).unref();
  }, TURN_TIMEOUT_MS);
  const code: number = await new Promise((res, rej) => {
    child.on('error', rej);
    child.on('close', (c) => res(c ?? 0));
  });
  clearTimeout(timer);
  writeFileSync(args.transcriptPath, stdout);
  if (stderr) writeFileSync(args.transcriptPath.replace(/\.json$/, '.stderr.txt'), stderr);
  if (code !== 0 && !timedOut) {
    console.error(`harness: claude exited ${code}; stderr tail:\n${stderr.slice(-1500)}`);
  }
  const parsed = ClaudeTurnSchema.safeParse(safeJson(stdout));
  return { stdout, stderr, data: parsed.success ? parsed.data : {} };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function brackishCall(
  brackishBin: string,
  env: NodeJS.ProcessEnv,
  args: string[],
): { stdout: string; stderr: string; code: number } {
  const r = spawnSync(brackishBin, args, { env, encoding: 'utf8' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? -1 };
}

/**
 * Extract the connect line from the server Claude's output. The skill prescribes
 * `/brackish connect URL --token T --identity NAME` as the format. We also accept
 * the bare `brackish connect …` form as a fallback (older skill text).
 */
function extractSlashConnect(result: string): string | null {
  const m = result.match(/\/brackish connect https?:\/\/\S+ --token \S+ --identity \S+/);
  if (m) return m[0];
  const fallback = result.match(/brackish connect https?:\/\/\S+ --token \S+ --identity \S+/);
  return fallback ? `/${fallback[0]}` : null;
}

/** Run `brackish install --local --yes --permission` in `cwd`. Writes `<cwd>/.claude/skills/brackish/`
 *  + project settings.json hook + Bash(brackish *) allow-rule. Mirrors the path a real user takes. */
function installLocalSkill(brackishBin: string, cwd: string, env: NodeJS.ProcessEnv): void {
  const r = spawnSync(brackishBin, ['install', '--local', '--yes', '--permission', '--force'], {
    cwd,
    env,
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Error(`brackish install --local failed (cwd=${cwd}):\n${r.stderr}`);
  }
}

async function main(): Promise<void> {
  const distEntry = ensureBuilt();
  const trialId = stamp();
  const trialDir = join(REPO_ROOT, 'trials', `skill-validate-${trialId}`);
  const serverDir = join(trialDir, 'server');
  const clientDir = join(trialDir, 'client');
  const serverHome = join(trialDir, 'server-home');
  const clientHome = join(trialDir, 'client-home');
  const binDir = join(trialDir, 'bin');
  const transcriptDir = join(trialDir, 'transcripts');
  for (const d of [trialDir, serverDir, clientDir, serverHome, clientHome, binDir, transcriptDir]) {
    mkdirSync(d, { recursive: true });
  }
  const brackishBin = writeWrapperBin(binDir, distEntry);

  // --- ROUND 1: server side ---

  const serverEnv: NodeJS.ProcessEnv = {
    ...process.env,
    BRACKISH_HOME: serverHome,
    BRACKISH_IDENTITY: 'host',
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
  };

  console.error(`harness: server-side \`brackish install --local --yes --permission\``);
  installLocalSkill(brackishBin, serverDir, serverEnv);

  console.error(`harness: round 1 — server Claude (/brackish invite ${PEER_NAME})`);
  const t0 = Date.now();
  const serverTurn = await runClaude({
    cwd: serverDir,
    env: serverEnv,
    prompt: `/brackish invite ${PEER_NAME}`,
    budgetUsd: SERVER_BUDGET_USD,
    transcriptPath: join(transcriptDir, 'server.json'),
  });
  console.error(
    `harness:   done in ${((Date.now() - t0) / 1000).toFixed(1)}s ($${(serverTurn.data.total_cost_usd ?? 0).toFixed(3)}, ${serverTurn.data.num_turns ?? 0} model-turns)`,
  );

  const serverResult = serverTurn.data.result ?? '';
  const slashConnect = extractSlashConnect(serverResult);
  if (!slashConnect) {
    console.error('harness: FAIL — server Claude did not emit a parseable connect command');
    console.error('---- server result ----');
    console.error(serverResult);
    process.exit(1);
  }
  const printedSlashForm = serverResult.includes(slashConnect);
  console.error(
    `harness: extracted slash-form: ${slashConnect}${printedSlashForm ? '' : ' (recovered from bare bash form — server did NOT print the /brackish prefix)'}`,
  );

  const urlMatch = slashConnect.match(/(https?:\/\/\S+)/);
  if (!urlMatch?.[1]) {
    console.error('harness: FAIL — connect command lacked a URL');
    process.exit(1);
  }
  const tcpUrl = urlMatch[1];
  console.error(`harness: server daemon URL = ${tcpUrl}`);

  // --- ROUND 2: client side ---

  const clientEnv: NodeJS.ProcessEnv = {
    ...process.env,
    BRACKISH_HOME: clientHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
  };

  console.error(`harness: client-side \`brackish install --local --yes --permission\``);
  installLocalSkill(brackishBin, clientDir, clientEnv);

  console.error(`harness: round 2 — client Claude (${slashConnect})`);
  const t1 = Date.now();
  const clientTurn = await runClaude({
    cwd: clientDir,
    env: clientEnv,
    prompt: slashConnect,
    budgetUsd: CLIENT_BUDGET_USD,
    transcriptPath: join(transcriptDir, 'client.json'),
  });
  console.error(
    `harness:   done in ${((Date.now() - t1) / 1000).toFixed(1)}s ($${(clientTurn.data.total_cost_usd ?? 0).toFixed(3)}, ${clientTurn.data.num_turns ?? 0} model-turns)`,
  );

  // --- VERIFY ---

  const failures: string[] = [];

  // 1. Client config.toml should exist with token + server URL.
  const clientCfgPath = join(clientHome, 'config.toml');
  if (!existsSync(clientCfgPath)) {
    failures.push(`client config not written at ${clientCfgPath}`);
  } else {
    const cfg = readFileSync(clientCfgPath, 'utf8');
    if (!cfg.includes(PEER_NAME)) failures.push(`client config missing identity=${PEER_NAME}`);
    if (!cfg.includes('token')) failures.push('client config missing token=');
    if (!cfg.includes('server')) failures.push('client config missing server=');
    console.error('--- client config.toml ---');
    console.error(cfg.trim());
  }

  // 2. Server daemon should respond to a whoami over the printed URL (using the client's saved token).
  const verifyCall = brackishCall(brackishBin, clientEnv, ['whoami', '--json']);
  if (verifyCall.code !== 0) {
    failures.push(`whoami from client failed: ${verifyCall.stderr.trim()}`);
  } else {
    console.error('--- whoami from client ---');
    console.error(verifyCall.stdout.trim());
    const whoami = safeJson(verifyCall.stdout) as { identity?: string; target?: string };
    if (whoami?.identity !== PEER_NAME) {
      failures.push(`whoami identity was ${whoami?.identity}, expected ${PEER_NAME}`);
    }
  }

  // 3. End-to-end: client creates a doc, server-side observer reads it.
  const createDoc = brackishCall(brackishBin, clientEnv, ['doc', 'new', 'validation']);
  if (createDoc.code !== 0) {
    failures.push(`client failed to create doc: ${createDoc.stderr.trim()}`);
  } else {
    const observerEnv: NodeJS.ProcessEnv = {
      ...process.env,
      BRACKISH_HOME: serverHome,
      BRACKISH_IDENTITY: 'observer',
    };
    const listDocs = brackishCall(brackishBin, observerEnv, ['documents', '--json']);
    if (listDocs.code !== 0) {
      failures.push(`server-side document list failed: ${listDocs.stderr.trim()}`);
    } else {
      const docs = safeJson(listDocs.stdout) as { documents?: Array<{ name?: string }> };
      const names = (docs?.documents ?? []).map((d) => d.name);
      if (!names.includes('validation')) {
        failures.push(`server didn't see doc 'validation'; saw ${JSON.stringify(names)}`);
      } else {
        console.error('--- round-trip confirmed: server sees doc "validation" ---');
      }
    }
  }

  // --- TEARDOWN: stop the server daemon ---
  const down = brackishCall(brackishBin, serverEnv, ['down']);
  console.error(`harness: brackish down → ${down.stdout.trim() || down.stderr.trim()}`);

  // --- REPORT ---
  if (failures.length === 0) {
    console.error('\nharness: ALL CHECKS PASSED');
    console.error(`  trial dir: ${trialDir}`);
    process.exit(0);
  }
  console.error(`\nharness: ${failures.length} FAILURE(S):`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error(`  trial dir: ${trialDir}`);
  process.exit(1);
}

main().catch((e) => {
  console.error('harness: fatal', e);
  process.exit(1);
});
