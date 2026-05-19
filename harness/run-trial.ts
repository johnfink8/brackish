// Adversarial-trial orchestrator.
//
// Spawns a brackish daemon in a fresh per-trial sandbox, then drives two `claude -p`
// sub-sessions (one per side) in an event-driven loop until either the success
// criterion is met, both sides stand down for two consecutive rounds, or maxRounds
// is hit. Every Claude turn is captured under `trials/<scenario>-<ts>/transcripts/`.
//
// Run: `npx tsx harness/run-trial.ts [scenario-name]`  (default: chat-app)
//
// Assumes: `claude` CLI on PATH; brackish has been built (`npm run build` writes dist/cli.js).
// The harness rebuilds dist if missing.

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';
import {
  EndpointListResponseSchema,
  EventListResponseSchema,
  InboxResponseSchema,
  SchemaListResponseSchema,
} from '../src/lib/models.js';
import { chatAppScenario } from './scenarios/chat-app.js';
import type { DocumentSummary, Scenario, Side } from './types.js';

// Final-text shape from `claude -p --output-format json`. Only the fields we read.
const ClaudeTurnResultSchema = z
  .object({
    result: z.string().optional(),
    total_cost_usd: z.number().optional(),
    duration_ms: z.number().optional(),
    num_turns: z.number().optional(),
  })
  .passthrough();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

const SCENARIOS: Record<string, Scenario> = {
  'chat-app': chatAppScenario,
};

// --- shell-out helpers ---

function isoStamp(): string {
  const d = new Date();
  const z = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${z(d.getUTCMonth() + 1)}${z(d.getUTCDate())}-${z(d.getUTCHours())}${z(d.getUTCMinutes())}${z(d.getUTCSeconds())}`;
}

function ensureBrackishBuilt(): string {
  const distEntry = join(REPO_ROOT, 'dist', 'cli.js');
  if (!existsSync(distEntry)) {
    console.error('harness: dist/cli.js missing, running `npm run build`...');
    const r = spawnSync('npm', ['run', 'build'], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
    if (r.status !== 0) throw new Error('npm run build failed');
  }
  return distEntry;
}

function writeWrapperBin(binDir: string, brackishEntry: string): string {
  mkdirSync(binDir, { recursive: true });
  const wrapper = join(binDir, 'brackish');
  const node = process.execPath;
  writeFileSync(wrapper, `#!/bin/sh\nexec "${node}" "${brackishEntry}" "$@"\n`, { mode: 0o755 });
  chmodSync(wrapper, 0o755);
  return wrapper;
}

async function waitForSocket(socketPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(socketPath)) return;
    await sleep(50);
  }
  throw new Error(`socket ${socketPath} did not appear within ${timeoutMs}ms`);
}

// --- brackish queries (the harness uses brackish itself as observer) ---

function brackishCall(
  brackishBin: string,
  brackishHome: string,
  identity: Side | 'observer',
  args: string[],
): { stdout: string; stderr: string; code: number } {
  const r = spawnSync(brackishBin, args, {
    env: {
      ...process.env,
      BRACKISH_HOME: brackishHome,
      BRACKISH_SOCKET: join(brackishHome, 'brackish.sock'),
      BRACKISH_IDENTITY: identity,
    },
    encoding: 'utf8',
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? -1 };
}

function getInboxCount(brackishBin: string, brackishHome: string, side: Side): number {
  const r = brackishCall(brackishBin, brackishHome, side, ['inbox', '--json']);
  if (r.code !== 0) return 0;
  const parsed = InboxResponseSchema.safeParse(safeJsonUnknown(r.stdout));
  if (!parsed.success) return 0;
  return parsed.data.documents.reduce((acc, d) => acc + d.newCount, 0);
}

function getDocumentSummary(
  brackishBin: string,
  brackishHome: string,
  documentName: string,
): DocumentSummary {
  // 'observer' identity reads via the socket; the socket transport is peer-trust so the harness
  // can self-declare any identity. Using a dedicated one keeps cursor state from polluting either side.
  const endpointsRes = brackishCall(brackishBin, brackishHome, 'observer', [
    'endpoint',
    'list',
    documentName,
    '--json',
  ]);
  const schemasRes = brackishCall(brackishBin, brackishHome, 'observer', [
    'schema',
    'list',
    documentName,
    '--json',
  ]);
  const readRes = brackishCall(brackishBin, brackishHome, 'observer', [
    'read',
    documentName,
    '--since',
    '0',
    '--limit',
    '1000',
    '--json',
  ]);

  const eps =
    EndpointListResponseSchema.safeParse(safeJsonUnknown(endpointsRes.stdout)).data?.endpoints ??
    [];
  const schemas =
    SchemaListResponseSchema.safeParse(safeJsonUnknown(schemasRes.stdout)).data?.schemas ?? [];
  const events =
    EventListResponseSchema.safeParse(safeJsonUnknown(readRes.stdout)).data?.events ?? [];

  // An identity is "accepted" iff currentVersion is non-null.
  // It's "in flight" if latestProposedVersion > (currentVersion ?? 0).
  const acceptedEndpoints = eps
    .filter((e) => typeof e.currentVersion === 'number')
    .map((e) => `${e.method.toUpperCase()} ${e.path}`);
  const proposedEndpoints = eps
    .filter(
      (e) =>
        typeof e.latestProposedVersion === 'number' &&
        e.latestProposedVersion > (e.currentVersion ?? 0),
    )
    .map((e) => `${e.method.toUpperCase()} ${e.path}`);
  const acceptedSchemas = schemas
    .filter((s) => typeof s.currentVersion === 'number')
    .map((s) => s.name);
  const proposedSchemas = schemas
    .filter(
      (s) =>
        typeof s.latestProposedVersion === 'number' &&
        s.latestProposedVersion > (s.currentVersion ?? 0),
    )
    .map((s) => s.name);

  // Convention status: walk the event stream for convention-kind events, latest wins.
  let conventionStatus: 'none' | 'proposed' | 'accepted' = 'none';
  let rejectionCount = 0;
  for (const e of events) {
    if (e.kind === 'artifact_rejected') rejectionCount++;
    if (
      e.kind !== 'artifact_proposed' &&
      e.kind !== 'artifact_accepted' &&
      e.kind !== 'artifact_rejected'
    )
      continue;
    if (e.artifactKind !== 'convention') continue;
    if (e.kind === 'artifact_accepted') conventionStatus = 'accepted';
    else if (conventionStatus !== 'accepted') conventionStatus = 'proposed';
  }

  return {
    acceptedEndpoints,
    proposedEndpoints,
    acceptedSchemas,
    proposedSchemas,
    conventionStatus,
    rejectionCount,
    eventCount: events.length,
  };
}

function safeJsonUnknown(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

// --- Claude spawn ---

type TurnResult = {
  finalText: string;
  costUsd: number;
  durationMs: number;
  numTurns: number;
  saidStandDown: boolean;
  raw: unknown;
};

async function runOneTurn(args: {
  side: Side;
  prompt: string;
  cwd: string;
  brackishHome: string;
  budgetUsd: number;
  pathBinDir: string;
  transcriptPath: string;
  /** Hard wall-clock cap; if the sub-claude doesn't exit by then it's SIGTERMed. */
  timeoutMs: number;
}): Promise<TurnResult> {
  const env = {
    ...process.env,
    BRACKISH_HOME: args.brackishHome,
    BRACKISH_SOCKET: join(args.brackishHome, 'brackish.sock'),
    BRACKISH_IDENTITY: args.side,
    PATH: `${args.pathBinDir}:${process.env.PATH ?? ''}`,
  };

  // `claude -p` defaults: bypass permissions, allow only Bash, JSON output, no session persistence.
  // We *don't* use --bare because that disables OAuth/keychain auth. Instead we accept that the
  // user's ~/.claude/CLAUDE.md gets inherited — it's about style preferences, not negotiation behavior.
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

  const child = spawn('claude', claudeArgs, {
    cwd: args.cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => {
    stdout += d.toString();
  });
  child.stderr.on('data', (d) => {
    stderr += d.toString();
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    console.error(`harness: ${args.side} turn exceeded ${args.timeoutMs}ms wall clock — SIGTERM`);
    child.kill('SIGTERM');
    // Escalate if it doesn't die quickly.
    setTimeout(() => child.kill('SIGKILL'), 5000).unref();
  }, args.timeoutMs);

  const code: number = await new Promise((res, rej) => {
    child.on('error', rej);
    child.on('close', (c) => res(c ?? 0));
  });
  clearTimeout(timer);

  // Write the raw transcript file regardless of outcome.
  writeFileSync(args.transcriptPath, stdout);
  if (stderr) {
    writeFileSync(args.transcriptPath.replace(/\.json$/, '.stderr.txt'), stderr);
  }

  if (code !== 0 && !timedOut) {
    console.error(
      `harness: claude exited ${code} for ${args.side}; stderr:\n${stderr.slice(-2000)}`,
    );
  }

  const parsed = ClaudeTurnResultSchema.safeParse(safeJsonUnknown(stdout));
  const data = parsed.success ? parsed.data : {};
  const finalText = data.result ?? '';
  const costUsd = data.total_cost_usd ?? 0;
  const durationMs = data.duration_ms ?? 0;
  const numTurns = data.num_turns ?? 0;
  const saidStandDown = /\bSTAND_?DOWN\b/i.test(finalText);

  return { finalText, costUsd, durationMs, numTurns, saidStandDown, raw: data };
}

function meetsSuccessCriterion(summary: DocumentSummary, scenario: Scenario): boolean {
  const c = scenario.successCriterion;
  if (summary.acceptedEndpoints.length < c.minAcceptedEndpoints) return false;
  if (c.requireAcceptedConvention && summary.conventionStatus !== 'accepted') return false;
  if (c.requireRejectionCycle && summary.rejectionCount < 1) return false;
  return true;
}

// --- final render ---

function renderFinal(
  brackishBin: string,
  brackishHome: string,
  documentName: string,
  finalDir: string,
): void {
  const ymlPath = join(finalDir, 'openapi.yaml');
  const mdPath = join(finalDir, 'negotiation.md');
  const tocPath = join(finalDir, 'toc.txt');
  const yml = brackishCall(brackishBin, brackishHome, 'observer', [
    'visualize',
    documentName,
    '--format',
    'openapi',
  ]);
  writeFileSync(ymlPath, yml.stdout);
  const md = brackishCall(brackishBin, brackishHome, 'observer', [
    'visualize',
    documentName,
    '--format',
    'markdown',
  ]);
  writeFileSync(mdPath, md.stdout);
  const toc = brackishCall(brackishBin, brackishHome, 'observer', ['visualize', documentName]);
  writeFileSync(tocPath, toc.stdout);
}

// --- main ---

function parseArgs(): {
  scenarioName: string;
  maxRoundsOverride?: number;
  budgetOverride?: number;
} {
  const args = process.argv.slice(2);
  let scenarioName = 'chat-app';
  let maxRoundsOverride: number | undefined;
  let budgetOverride: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--max-rounds') {
      const next = args[++i];
      if (!next) throw new Error('--max-rounds requires a number');
      maxRoundsOverride = Number.parseInt(next, 10);
    } else if (a === '--budget') {
      const next = args[++i];
      if (!next) throw new Error('--budget requires a number');
      budgetOverride = Number.parseFloat(next);
    } else if (a && !a.startsWith('--')) {
      scenarioName = a;
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  const result: { scenarioName: string; maxRoundsOverride?: number; budgetOverride?: number } = {
    scenarioName,
  };
  if (maxRoundsOverride !== undefined) result.maxRoundsOverride = maxRoundsOverride;
  if (budgetOverride !== undefined) result.budgetOverride = budgetOverride;
  return result;
}

async function main(): Promise<void> {
  const { scenarioName, maxRoundsOverride, budgetOverride } = parseArgs();
  const baseScenario = SCENARIOS[scenarioName];
  if (!baseScenario) {
    console.error(`unknown scenario: ${scenarioName}. known: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exit(2);
  }
  const scenario: Scenario = {
    ...baseScenario,
    ...(maxRoundsOverride !== undefined ? { maxRounds: maxRoundsOverride } : {}),
    ...(budgetOverride !== undefined ? { perTurnBudgetUsd: budgetOverride } : {}),
  };

  const brackishEntry = ensureBrackishBuilt();
  const trialId = isoStamp();
  const trialDir = join(REPO_ROOT, 'trials', `${scenario.name}-${trialId}`);
  const brackishHome = join(trialDir, 'brackish-home');
  const transcriptDir = join(trialDir, 'transcripts');
  const finalDir = join(trialDir, 'final');
  const binDir = join(trialDir, 'bin');
  const frontendDir = join(trialDir, 'frontend');
  const backendDir = join(trialDir, 'backend');

  for (const d of [
    trialDir,
    brackishHome,
    transcriptDir,
    finalDir,
    binDir,
    frontendDir,
    backendDir,
  ]) {
    mkdirSync(d, { recursive: true });
  }

  // Side scaffolding: CLAUDE.md + notes.md only (the "minimal" choice).
  //
  // The CLAUDE.md is the role brief followed by the brackish skill teaching — without the skill,
  // trial Claudes have to invent vocabulary for `x-brackish` fields and end up with slips like
  // `sideEffect` (singular). Production Claudes have the skill via `brackish install`; the trial
  // gets parity by inlining the skill body here.
  const skillBody = readFileSync(join(REPO_ROOT, 'skill', 'SKILL.md'), 'utf8');
  const skillAppendix = [
    '',
    '---',
    '',
    '# Appendix: brackish skill (canonical teaching)',
    '',
    'The content below is `skill/SKILL.md` shipped with brackish. In production, Claudes load this via `brackish install`; this trial inlines it so you have the same teaching. **Use the canonical field names it defines** (e.g. `x-brackish.sideEffects` plural, not `sideEffect`).',
    '',
    skillBody,
  ].join('\n');
  writeFileSync(join(frontendDir, 'CLAUDE.md'), scenario.briefs.frontend + skillAppendix);
  writeFileSync(join(backendDir, 'CLAUDE.md'), scenario.briefs.backend + skillAppendix);
  writeFileSync(
    join(frontendDir, 'notes.md'),
    "# scratchpad — frontend Claude\n\nUse this for any local note-taking that's not part of the contract.\n",
  );
  writeFileSync(
    join(backendDir, 'notes.md'),
    "# scratchpad — backend Claude\n\nUse this for any local note-taking that's not part of the contract.\n",
  );

  // Wrapper bin: ensures the sub-claudes' `brackish` resolves to *our* dist build, not whatever
  // global install might be on the user's PATH.
  const brackishBin = writeWrapperBin(binDir, brackishEntry);

  // Record the run config for repeatability.
  writeFileSync(
    join(trialDir, 'config.json'),
    `${JSON.stringify(
      {
        scenario: scenario.name,
        documentName: scenario.documentName,
        firstMover: scenario.firstMover,
        maxRounds: scenario.maxRounds,
        perTurnBudgetUsd: scenario.perTurnBudgetUsd,
        successCriterion: scenario.successCriterion,
        startedAt: new Date().toISOString(),
        brackishEntry,
      },
      null,
      2,
    )}\n`,
  );

  // Start brackish daemon.
  const serverLog = join(trialDir, 'server.log');
  const server: ChildProcess = spawn(brackishBin, ['serve'], {
    env: { ...process.env, BRACKISH_HOME: brackishHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLogFd = serverLog;
  server.stdout?.on('data', (d) => appendFileSync(serverLogFd, d));
  server.stderr?.on('data', (d) => appendFileSync(serverLogFd, d));
  const socketPath = join(brackishHome, 'brackish.sock');
  await waitForSocket(socketPath, 5000);
  console.error(`harness: brackish daemon ready at ${socketPath}`);

  // Drive the negotiation.
  let round = 1;
  let standDownStreak = 0;
  let nextSide: Side = scenario.firstMover;
  const usedStarter: Set<Side> = new Set();
  const turnLog: Array<{
    round: number;
    side: Side;
    isStarter: boolean;
    costUsd: number;
    durationMs: number;
    numTurns: number;
    saidStandDown: boolean;
    finalTextPreview: string;
  }> = [];
  const summaryHistory: DocumentSummary[] = [];
  let terminationReason = 'maxRounds';

  try {
    while (round <= scenario.maxRounds) {
      const isStarter = !usedStarter.has(nextSide);
      usedStarter.add(nextSide);
      const prompt = isStarter ? scenario.starterPrompts[nextSide] : scenario.wakePrompt;
      const transcriptPath = join(
        transcriptDir,
        `round-${String(round).padStart(3, '0')}-${nextSide}.json`,
      );

      console.error(`harness: round ${round} — ${nextSide} ${isStarter ? '(starter)' : '(wake)'}`);
      const turnStart = Date.now();
      const turn = await runOneTurn({
        side: nextSide,
        prompt,
        cwd: nextSide === 'frontend' ? frontendDir : backendDir,
        brackishHome,
        budgetUsd: scenario.perTurnBudgetUsd,
        timeoutMs: scenario.perTurnTimeoutMs,
        pathBinDir: binDir,
        transcriptPath,
      });
      const wallMs = Date.now() - turnStart;
      console.error(
        `harness:   done in ${(wallMs / 1000).toFixed(1)}s ($${turn.costUsd.toFixed(3)}, ${turn.numTurns} model-turns, stand_down=${turn.saidStandDown})`,
      );

      turnLog.push({
        round,
        side: nextSide,
        isStarter,
        costUsd: turn.costUsd,
        durationMs: turn.durationMs,
        numTurns: turn.numTurns,
        saidStandDown: turn.saidStandDown,
        finalTextPreview: turn.finalText.slice(0, 240),
      });

      // Snapshot brackish state.
      const summary = getDocumentSummary(brackishBin, brackishHome, scenario.documentName);
      summaryHistory.push(summary);
      console.error(
        `harness:   doc state — endpoints accepted=${summary.acceptedEndpoints.length}/proposed=${summary.proposedEndpoints.length}; schemas accepted=${summary.acceptedSchemas.length}/proposed=${summary.proposedSchemas.length}; convention=${summary.conventionStatus}; rejections=${summary.rejectionCount}`,
      );

      if (meetsSuccessCriterion(summary, scenario)) {
        terminationReason = 'success';
        console.error(`harness: SUCCESS criterion met after round ${round}`);
        break;
      }

      const fInbox = getInboxCount(brackishBin, brackishHome, 'frontend');
      const bInbox = getInboxCount(brackishBin, brackishHome, 'backend');
      console.error(`harness:   inboxes — frontend=${fInbox}, backend=${bInbox}`);

      if (turn.saidStandDown && fInbox === 0 && bInbox === 0) {
        standDownStreak++;
        if (standDownStreak >= 2) {
          terminationReason = 'mutualStandDown';
          console.error('harness: both sides stood down for 2 consecutive rounds — terminating');
          break;
        }
      } else {
        standDownStreak = 0;
      }

      // Pick next side: prefer the other side if it has pending. Otherwise stick.
      const other: Side = nextSide === 'frontend' ? 'backend' : 'frontend';
      const inboxes: Record<Side, number> = { frontend: fInbox, backend: bInbox };
      if (inboxes[other] > 0) {
        nextSide = other;
      } else if (inboxes[nextSide] > 0) {
        // current side has unread (rare — usually means they didn't run `brackish read`)
      } else {
        nextSide = other; // default alternation when both empty
      }

      round++;
    }
    if (round > scenario.maxRounds) {
      console.error(`harness: hit maxRounds=${scenario.maxRounds}`);
    }
  } finally {
    // Render final artifacts BEFORE killing the daemon.
    try {
      renderFinal(brackishBin, brackishHome, scenario.documentName, finalDir);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`harness: render failed: ${msg}`);
    }
    // Kill daemon.
    server.kill('SIGTERM');
    // Give it a moment to die cleanly so the socket is released.
    await sleep(200);
  }

  // Write summary report.
  const lastSummary = summaryHistory[summaryHistory.length - 1];
  const totalCost = turnLog.reduce((acc, t) => acc + t.costUsd, 0);
  const summaryReport = [
    `# trial ${scenario.name}-${trialId}`,
    `terminated: ${terminationReason}`,
    `rounds: ${turnLog.length}`,
    `total cost: $${totalCost.toFixed(2)}`,
    '',
    '## final document',
    `endpoints accepted: ${lastSummary?.acceptedEndpoints.length ?? 0}`,
    `  - ${(lastSummary?.acceptedEndpoints ?? []).join('\n  - ') || '(none)'}`,
    `endpoints in-flight: ${lastSummary?.proposedEndpoints.length ?? 0}`,
    `  - ${(lastSummary?.proposedEndpoints ?? []).join('\n  - ') || '(none)'}`,
    `schemas accepted: ${lastSummary?.acceptedSchemas.length ?? 0}`,
    `  - ${(lastSummary?.acceptedSchemas ?? []).join('\n  - ') || '(none)'}`,
    `convention: ${lastSummary?.conventionStatus ?? 'none'}`,
    `rejections during run: ${lastSummary?.rejectionCount ?? 0}`,
    `total events: ${lastSummary?.eventCount ?? 0}`,
    '',
    '## per-round',
    ...turnLog.map(
      (t) =>
        `  round ${String(t.round).padStart(3, '0')} ${t.side.padEnd(8)} ${t.isStarter ? 'STARTER' : 'wake   '}  ${(t.durationMs / 1000).toFixed(1)}s  $${t.costUsd.toFixed(3)}  ${t.numTurns} model-turns${t.saidStandDown ? '  STAND_DOWN' : ''}`,
    ),
    '',
  ].join('\n');
  writeFileSync(join(trialDir, 'summary.txt'), summaryReport);

  console.error(`\nharness: trial complete.\n  → ${trialDir}`);
  console.error(`harness: termination=${terminationReason}, total=$${totalCost.toFixed(2)}`);
}

main().catch((e) => {
  console.error('harness: fatal', e);
  process.exit(1);
});
