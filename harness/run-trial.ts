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
import { appendFileSync, chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
import { extractDemoFromTrial, writeDemoDataFile } from './extract-demo.js';
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
  // Always rebuild — `dist/cli.js` existing isn't enough, it might predate uncommitted edits.
  // A half-fresh run (new skill text + stale CLI) silently invalidates the trial. Build is
  // cheap (~20ms with tsup cache); the false-positive risk is not.
  console.error('harness: running `npm run build`...');
  const r = spawnSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' });
  if (r.status !== 0) throw new Error('npm run build failed');
  return join(REPO_ROOT, 'dist', 'cli.js');
}

function writeWrapperBin(binDir: string, brackishEntry: string, callLogPath: string): string {
  mkdirSync(binDir, { recursive: true });
  const wrapper = join(binDir, 'brackish');
  const node = process.execPath;
  // Tee every brackish invocation + its stdout/stderr/exit to callLogPath. The model's
  // streamed transcript is its narrative; this log is ground truth at the CLI layer.
  // Used to diagnose skill-setup issues (wrong flags, missing --grant, ordering bugs)
  // and brackish I/O the model might silently misrepresent.
  const script = `#!/bin/sh
set -u
LOG="${callLogPath}"
TS="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"
ARGS_QUOTED=""
for a in "$@"; do ARGS_QUOTED="$ARGS_QUOTED \\"$a\\""; done
{
  echo "===== $TS pid=$$ cwd=$PWD identity=\${BRACKISH_IDENTITY:-?} home=\${BRACKISH_HOME:-?} ====="
  echo "+ brackish$ARGS_QUOTED"
} >> "$LOG" 2>/dev/null
STDOUT_FILE="$(mktemp -t brackish-stdout.XXXXXX)"
STDERR_FILE="$(mktemp -t brackish-stderr.XXXXXX)"
"${node}" "${brackishEntry}" "$@" >"$STDOUT_FILE" 2>"$STDERR_FILE"
EC=$?
{
  if [ -s "$STDOUT_FILE" ]; then echo "--- stdout ---"; cat "$STDOUT_FILE"; fi
  if [ -s "$STDERR_FILE" ]; then echo "--- stderr ---"; cat "$STDERR_FILE"; fi
  echo "--- exit=$EC ---"
} >> "$LOG" 2>/dev/null
cat "$STDOUT_FILE"
cat "$STDERR_FILE" >&2
rm -f "$STDOUT_FILE" "$STDERR_FILE"
exit $EC
`;
  writeFileSync(wrapper, script, { mode: 0o755 });
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

  // `claude -p` defaults: bypass permissions, allowed tools = Bash (run brackish) + Read/Glob/Grep
  // (open SKILL.md and subfiles). Without Read, the model only sees the skill's description blurb
  // and never the body — observed in skill-validate trials before this widening. stream-json
  // captures every assistant text + tool_use + tool_result as it arrives so a mid-flight SIGTERM
  // doesn't lose the partial transcript. We *don't* use --bare because that disables OAuth.
  const claudeArgs = [
    '--print',
    '--permission-mode',
    'bypassPermissions',
    '--allowedTools',
    'Bash,Read,Glob,Grep',
    '--output-format',
    'stream-json',
    '--verbose',
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

  // Append-as-it-arrives so a budget-cap SIGTERM still leaves us a partial transcript.
  writeFileSync(args.transcriptPath, '');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => {
    const chunk = d.toString();
    stdout += chunk;
    appendFileSync(args.transcriptPath, chunk);
  });
  child.stderr.on('data', (d) => {
    stderr += d.toString();
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    console.error(`harness: ${args.side} turn exceeded ${args.timeoutMs}ms wall clock — SIGTERM`);
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5000).unref();
  }, args.timeoutMs);

  const code: number = await new Promise((res, rej) => {
    child.on('error', rej);
    child.on('close', (c) => res(c ?? 0));
  });
  clearTimeout(timer);

  if (stderr) {
    writeFileSync(args.transcriptPath.replace(/\.ndjson$/, '.stderr.txt'), stderr);
  }

  if (code !== 0 && !timedOut) {
    console.error(
      `harness: claude exited ${code} for ${args.side}; stderr:\n${stderr.slice(-2000)}`,
    );
  }

  const data = extractResultFromStream(stdout);
  const finalText = data.result ?? '';
  const costUsd = data.total_cost_usd ?? 0;
  const durationMs = data.duration_ms ?? 0;
  const numTurns = data.num_turns ?? 0;
  const saidStandDown = /\bSTAND_?DOWN\b/i.test(finalText);

  return { finalText, costUsd, durationMs, numTurns, saidStandDown, raw: data };
}

/** Walk the NDJSON stream and pull the final `result` event's payload. Tolerates
 *  non-JSON lines (some claude versions interleave banner text in --verbose mode)
 *  and missing-result-event (truncation from budget-cap SIGTERM). */
function extractResultFromStream(stream: string): z.infer<typeof ClaudeTurnResultSchema> {
  let lastResult: z.infer<typeof ClaudeTurnResultSchema> = {};
  for (const line of stream.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as { type?: string };
      if (obj.type === 'result') {
        const parsed = ClaudeTurnResultSchema.safeParse(obj);
        if (parsed.success) lastResult = parsed.data;
      }
    } catch {
      // skip non-JSON lines
    }
  }
  return lastResult;
}

function meetsSuccessCriterion(summary: DocumentSummary, scenario: Scenario): boolean {
  const c = scenario.successCriterion;
  if (summary.acceptedEndpoints.length < c.minAcceptedEndpoints) return false;
  if (c.requireAcceptedConvention && summary.conventionStatus !== 'accepted') return false;
  if (c.requireRejectionCycle && summary.rejectionCount < 1) return false;
  if (
    c.requireSettled &&
    (summary.proposedEndpoints.length > 0 || summary.proposedSchemas.length > 0)
  ) {
    return false;
  }
  return true;
}

// --- final render ---

/** Per-side post-mortem critique budget. Smaller than negotiation rounds — reflection doesn't
 *  need much exploration; we mostly want one sub-Claude turn with a focused prompt. */
const CRITIQUE_BUDGET_USD = 0.4;

function buildCritiquePrompt(
  side: Side,
  terminationReason: string,
  summary: DocumentSummary | undefined,
): string {
  const accEnds = summary?.acceptedEndpoints.length ?? 0;
  const accSchemas = summary?.acceptedSchemas.length ?? 0;
  const rejs = summary?.rejectionCount ?? 0;
  return [
    `The brackish negotiation has ended. Termination: ${terminationReason}.`,
    `Final state: ${accEnds} endpoints accepted, ${accSchemas} schemas accepted, ${rejs} rejections during the run, convention ${summary?.conventionStatus ?? 'none'}.`,
    '',
    'This is a **post-mortem turn**. Do NOT propose, accept, reject, or withdraw anything. Do NOT call `brackish send`. You may read with `brackish read`, `brackish status`, `brackish endpoint show`, `brackish visualize` for grounding, but the goal is reflection — not action.',
    '',
    `You're the ${side} Claude. In ≤300 words, give an honest assessment of brackish as a tool you just used. Be concrete — cite specific verbs (\`brackish status\`, \`endpoint propose --file\`, etc.), flags, or error messages by name. Cover:`,
    '',
    '- **What worked.** Which verbs/flags/skill instructions saved you tokens or round-trips?',
    '- **Friction.** Where did you spend turns on things that should have been local or instantaneous? Any error message or skill section that was unclear?',
    '- **Missing.** What CLI verb, flag, or skill instruction would have saved you a turn?',
    '',
    'Focus on the tool experience. Do **not** restate the contract content.',
  ].join('\n');
}

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
  demoDataPath?: string;
} {
  const args = process.argv.slice(2);
  let scenarioName = 'chat-app';
  let maxRoundsOverride: number | undefined;
  let budgetOverride: number | undefined;
  let demoDataPath: string | undefined;
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
    } else if (a === '--demo-data') {
      const next = args[++i];
      if (!next) throw new Error('--demo-data requires a path');
      demoDataPath = next;
    } else if (a && !a.startsWith('--')) {
      scenarioName = a;
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  const result: {
    scenarioName: string;
    maxRoundsOverride?: number;
    budgetOverride?: number;
    demoDataPath?: string;
  } = { scenarioName };
  if (maxRoundsOverride !== undefined) result.maxRoundsOverride = maxRoundsOverride;
  if (budgetOverride !== undefined) result.budgetOverride = budgetOverride;
  if (demoDataPath !== undefined) result.demoDataPath = demoDataPath;
  return result;
}

async function main(): Promise<void> {
  const { scenarioName, maxRoundsOverride, budgetOverride, demoDataPath } = parseArgs();
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

  const critiqueDir = join(trialDir, 'critiques');
  for (const d of [
    trialDir,
    brackishHome,
    transcriptDir,
    finalDir,
    binDir,
    frontendDir,
    backendDir,
    critiqueDir,
  ]) {
    mkdirSync(d, { recursive: true });
  }

  // Side scaffolding: CLAUDE.md is the role brief ONLY — no brackish-specific text. In
  // production a Claude doesn't have an inlined plugin teaching in CLAUDE.md; it has the skill
  // installed via `brackish install`. The trial matches that path: we run `brackish install
  // --local --yes --permission --force` in each side's dir below, which drops the project-scope
  // skill into `.claude/skills/brackish/`, the UserPromptSubmit hook into `.claude/settings.json`,
  // and the `Bash(brackish *)` allow-rule. The sub-Claude discovers the skill the same way a
  // real user's Claude does.
  writeFileSync(join(frontendDir, 'CLAUDE.md'), scenario.briefs.frontend);
  writeFileSync(join(backendDir, 'CLAUDE.md'), scenario.briefs.backend);
  writeFileSync(
    join(frontendDir, 'notes.md'),
    "# scratchpad — frontend Claude\n\nUse this for any local note-taking that's not part of the contract.\n",
  );
  writeFileSync(
    join(backendDir, 'notes.md'),
    "# scratchpad — backend Claude\n\nUse this for any local note-taking that's not part of the contract.\n",
  );

  // Wrapper bin: ensures the sub-claudes' `brackish` resolves to *our* dist build, not whatever
  // global install might be on the user's PATH. Wrapper also tees every invocation +
  // stdout/stderr/exit to brackish-calls.log for ground-truth diagnosis.
  const callLogPath = join(trialDir, 'brackish-calls.log');
  writeFileSync(callLogPath, '');
  const brackishBin = writeWrapperBin(binDir, brackishEntry, callLogPath);

  // Install the brackish skill into each side's project-scope `.claude/`. Mirrors validate-skill.
  const installEnv = (home: string): NodeJS.ProcessEnv => ({
    ...process.env,
    BRACKISH_HOME: home,
    BRACKISH_SOCKET: join(home, 'brackish.sock'),
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
  });
  for (const [side, dir] of [
    ['frontend', frontendDir],
    ['backend', backendDir],
  ] as const) {
    console.error(`harness: ${side}-side \`brackish install --local --yes --permission\``);
    const r = spawnSync(brackishBin, ['install', '--local', '--yes', '--permission', '--force'], {
      cwd: dir,
      env: installEnv(brackishHome),
      encoding: 'utf8',
    });
    if (r.status !== 0) {
      throw new Error(`brackish install --local failed (cwd=${dir}):\n${r.stderr}`);
    }
  }

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
        `round-${String(round).padStart(3, '0')}-${nextSide}.ndjson`,
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

    // Post-mortem critiques: each side gets one read-only turn to assess brackish itself.
    // Failures here don't tank the trial — the negotiation result is the primary artifact.
    const lastSummaryForCritique = summaryHistory[summaryHistory.length - 1];
    console.error('harness: running post-mortem critiques (parallel)');
    const critiqueStart = Date.now();
    const critiqueResults = await Promise.allSettled(
      (['frontend', 'backend'] as const).map((side) =>
        runOneTurn({
          side,
          prompt: buildCritiquePrompt(side, terminationReason, lastSummaryForCritique),
          cwd: side === 'frontend' ? frontendDir : backendDir,
          brackishHome,
          budgetUsd: CRITIQUE_BUDGET_USD,
          timeoutMs: scenario.perTurnTimeoutMs,
          pathBinDir: binDir,
          transcriptPath: join(transcriptDir, `critique-${side}.ndjson`),
        }),
      ),
    );
    let critiqueCostTotal = 0;
    (['frontend', 'backend'] as const).forEach((side, i) => {
      const r = critiqueResults[i];
      if (!r) return;
      if (r.status === 'fulfilled') {
        writeFileSync(join(critiqueDir, `${side}.md`), r.value.finalText);
        critiqueCostTotal += r.value.costUsd;
        console.error(
          `harness:   ${side} critique: ${(r.value.durationMs / 1000).toFixed(1)}s, $${r.value.costUsd.toFixed(3)}`,
        );
      } else {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        writeFileSync(join(critiqueDir, `${side}.md`), `(critique failed: ${msg})\n`);
        console.error(`harness:   ${side} critique FAILED: ${msg}`);
      }
    });
    console.error(
      `harness:   critiques done in ${((Date.now() - critiqueStart) / 1000).toFixed(1)}s ($${critiqueCostTotal.toFixed(3)})`,
    );
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
  const negotiationCost = turnLog.reduce((acc, t) => acc + t.costUsd, 0);
  const summaryReport = [
    `# trial ${scenario.name}-${trialId}`,
    `terminated: ${terminationReason}`,
    `rounds: ${turnLog.length}`,
    `negotiation cost: $${negotiationCost.toFixed(2)} (critiques tracked separately under critiques/)`,
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

  if (demoDataPath !== undefined) {
    try {
      const data = extractDemoFromTrial(trialDir);
      writeDemoDataFile(data, demoDataPath);
      console.error(`harness: wrote demo data (${data.moves.length} moves) → ${demoDataPath}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`harness: --demo-data extraction failed: ${msg}`);
    }
  }

  console.error(`\nharness: trial complete.\n  → ${trialDir}`);
  console.error(
    `harness: termination=${terminationReason}, negotiation=$${negotiationCost.toFixed(2)}`,
  );
  console.error(`harness: critiques at ${critiqueDir}/{frontend,backend}.md`);
}

main().catch((e) => {
  console.error('harness: fatal', e);
  process.exit(1);
});
