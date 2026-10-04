import type { IssueTruncation, ValidationIssue } from "./types.ts";

/**
 * Deterministic, shared upper bound on the number of field-level issues a
 * single validation pass may emit — for BOTH inbound request validation and
 * persisted-entry recovery validation.
 *
 * Without it, a request that stays within the body-size and key-count limits
 * could force one full issue per offending value (e.g. 1000 non-scalar
 * measurements): a ~20KB rejected request would get a response three times
 * its size, and the same amplification would land in recovery logs for
 * corrupt restored data.
 *
 * The collector keeps the first MAX_DIAGNOSTIC_ISSUES issues encountered.
 * JSON arrays and object keys are visited in insertion order, so the retained
 * set is deterministic. Further issues are only counted, never built, and the
 * count is surfaced as an {@link IssueTruncation} summary so callers and
 * operators know diagnostics are incomplete. Suppression limits diagnostics
 * only: the validator still fails the whole input.
 *
 * As with every issue, the summary carries rule codes, JSON paths and counts
 * only — never submitted field values.
 */
export const MAX_DIAGNOSTIC_ISSUES = 100;

export class IssueCollector {
  readonly issues: ValidationIssue[] = [];
  private suppressed = 0;

  add(code: string, path: string, message: string): void {
    if (this.issues.length < MAX_DIAGNOSTIC_ISSUES) {
      this.issues.push({ code, path, message });
    } else {
      this.suppressed++;
    }
  }

  get truncated(): boolean {
    return this.suppressed > 0;
  }

  summary(): IssueTruncation | null {
    if (this.suppressed === 0) return null;
    return {
      code: "issues_truncated",
      limit: MAX_DIAGNOSTIC_ISSUES,
      reported: this.issues.length,
      remaining: this.suppressed,
    };
  }

  get ok(): boolean {
    return this.issues.length === 0 && this.suppressed === 0;
  }
}
