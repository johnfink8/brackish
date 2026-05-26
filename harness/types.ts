// Shared types for the adversarial-trial harness.

import type { DemoMove } from '../src/lib/demo-data.js';

export type Side = 'frontend' | 'backend';

export type Scenario = {
  /** Short scenario id, e.g. "chat-app". Becomes part of the trial dir name. */
  name: string;
  /** brackish document name that the two sides will use. */
  documentName: string;
  /** What/why/how for the trial's NOTES.md (trial-data-discipline). Optional. */
  notes?: { what: string; why: string; how: string };
  /** Moves replayed into the daemon BEFORE the first Claude turn, establishing a pre-existing
   *  accepted contract (renegotiation scenarios). Omit for greenfield (chat-app). */
  seedingMoves?: DemoMove[];
  /** CLAUDE.md contents for each side. */
  briefs: Record<Side, string>;
  /** Prompt for the very first turn of each side. Frames "what to do on day one". */
  starterPrompts: Record<Side, string>;
  /** Prompt for every subsequent turn. Should be terse — the CLAUDE.md does the heavy lifting. */
  wakePrompt: string;
  /** Which side goes first. */
  firstMover: Side;
  /** Hard cap on total rounds (frontend turn + backend turn = 2 rounds). */
  maxRounds: number;
  /** Hard cap on USD spent in each individual `claude -p` invocation. */
  perTurnBudgetUsd: number;
  /** Wall-clock cap per turn (ms). If exceeded the sub-claude is killed and the round records 0 model-turns. */
  perTurnTimeoutMs: number;
  successCriterion: {
    minAcceptedEndpoints: number;
    requireAcceptedConvention: boolean;
    requireRejectionCycle: boolean;
    /** When true, the doc must also have zero in-flight (proposed-but-not-acted-on) artifacts.
     *  Use for "land on a fully settled contract" scenarios; omit to let the min-bar trigger. */
    requireSettled?: boolean;
    // --- renegotiation delta (all optional; omit => greenfield, no constraint) ---
    // Named present/absent sets pin the specific architectural move (e.g. the new push endpoint
    // landed AND the obsolete poll endpoint is gone), so a seeded settled v1 can't satisfy the
    // criterion on its own. Endpoints match the "METHOD /path" form, case-insensitive.
    /** Endpoints that must be ACCEPTED in the final doc. */
    requireAcceptedEndpoints?: string[];
    /** Endpoints that must be ABSENT (retracted/superseded away) in the final doc. */
    requireAbsentEndpoints?: string[];
    /** Schemas that must be ACCEPTED in the final doc. */
    requireAcceptedSchemas?: string[];
    /** Schemas that must be ABSENT (retracted) in the final doc. */
    requireAbsentSchemas?: string[];
  };
};

/** Summary of what's currently in the brackish document, used for termination check + reporting. */
export type DocumentSummary = {
  acceptedEndpoints: string[]; // "GET /foo"
  proposedEndpoints: string[];
  acceptedSchemas: string[];
  proposedSchemas: string[];
  conventionStatus: 'none' | 'proposed' | 'accepted';
  rejectionCount: number;
  eventCount: number;
};
