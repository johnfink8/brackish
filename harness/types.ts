// Shared types for the adversarial-trial harness.

export type Side = 'frontend' | 'backend';

export type Scenario = {
  /** Short scenario id, e.g. "chat-app". Becomes part of the trial dir name. */
  name: string;
  /** brackish document name that the two sides will use. */
  documentName: string;
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
