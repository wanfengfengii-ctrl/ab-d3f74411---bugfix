import type { ValidationIssue } from "./types.ts";

/**
 * Unified, deterministic bound on validation diagnostics.
 *
 * Both the inbound request validator (validation.ts) and the recovery-path
 * contract validator (sharedValidation.ts) report every problem they find as
 * a field-level issue. A hostile request or a corrupt restored entry can
 * contain thousands of violations (e.g. one per measurement value), so
 * without a cap the diagnostics themselves become an amplification vector:
 * the 422 response would be several times larger than the rejected request,
 * and a single corrupt entry would flood the recovery logs.
 *
 * The collector therefore keeps at most {@link MAX_DIAGNOSTIC_ISSUES}
 * field-level issues and merely counts the rest. When anything was dropped,
 * the truncated tail is surfaced as one final machine-readable summary entry
 * (code {@link ISSUES_TRUNCATED_CODE}) carrying the number of omitted issues.
 * Validation itself still runs to completion and its outcome is unchanged:
 * the request is rejected as a whole (422) and a corrupt recovery entry is
 * never admitted — only the diagnostics are bounded.
 */

/** Maximum number of field-level issues reported per validated document. */
export const MAX_DIAGNOSTIC_ISSUES = 100;

/** Rule code of the machine-readable truncation summary entry. */
export const ISSUES_TRUNCATED_CODE = "issues_truncated";

export class IssueCollector {
  private readonly kept: ValidationIssue[] = [];
  private omitted = 0;

  add(code: string, path: string, message: string): void {
    if (this.kept.length < MAX_DIAGNOSTIC_ISSUES) {
      this.kept.push({ code, path, message });
    } else {
      this.omitted += 1;
    }
  }

  get ok(): boolean {
    return this.kept.length === 0 && this.omitted === 0;
  }

  /** Total number of issues detected, whether reported or omitted. */
  get total(): number {
    return this.kept.length + this.omitted;
  }

  /**
   * The bounded issue list: the kept field-level issues plus, when the cap
   * was exceeded, a final truncation summary. The summary carries only the
   * rule code, the "$" root path and counts — never paths, keys or values
   * from the omitted tail, so untrusted content cannot ride along.
   */
  get issues(): ValidationIssue[] {
    if (this.omitted === 0) return [...this.kept];
    return [
      ...this.kept,
      {
        code: ISSUES_TRUNCATED_CODE,
        path: "$",
        message:
          `diagnostic limit of ${MAX_DIAGNOSTIC_ISSUES} issues reached; ` +
          `${this.omitted} further issue(s) omitted`,
        omitted: this.omitted,
      },
    ];
  }
}
