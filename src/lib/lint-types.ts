// Shared types for lint / validate. Split into its own module so validate.ts (which feeds
// lint.ts) doesn't form a cycle.

export type LintIssue = {
  severity: 'error' | 'warn';
  field: string;
  message: string;
};

export type LintResult = {
  errors: LintIssue[];
  warnings: LintIssue[];
};
