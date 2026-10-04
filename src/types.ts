/**
 * Core domain types for the pathology manifest collaboration service.
 *
 * Privacy boundary: `Input*` types carry institution-local identifiers and must
 * never leave the process in logs, responses or persisted files. `Shared*`
 * types carry only irreversible per-category aliases and are safe to share.
 */

export const ID_CLASSES = ["patient", "accession", "record"] as const;
export type IdClass = (typeof ID_CLASSES)[number];

export type MeasurementValue = string | number | boolean | null;

export interface InputRecord {
  recordId: string;
  patientId: string;
  accessionId: string;
  /** Normalized: de-duplicated, lexicographically sorted. */
  relatedIds: string[];
  measurements: Record<string, MeasurementValue>;
}

export interface InputBatch {
  batchId: string;
  records: InputRecord[];
}

export interface SharedRecord {
  recordAlias: string;
  patientAlias: string;
  accessionAlias: string;
  relatedAliases: string[];
  measurements: Record<string, MeasurementValue>;
}

export interface SharedManifest {
  batchId: string;
  createdAt: string;
  contentHash: string;
  records: SharedRecord[];
}

export interface ValidationIssue {
  code: string;
  path: string;
  message: string;
  /**
   * Present only on the truncation summary entry (code "issues_truncated",
   * see diagnostics.ts): how many further issues were detected but not
   * reported. Never present on regular field-level issues.
   */
  omitted?: number;
}

/** Payload failed structural / referential validation -> HTTP 422. */
export class ValidationFailed extends Error {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super("manifest validation failed");
    this.name = "ValidationFailed";
    this.issues = issues;
  }
}

/**
 * A persisted shared manifest failed recovery validation during store load.
 * The service must refuse to start rather than serve or silently overwrite
 * the corrupt entry. Issues carry only rule codes and JSON paths, never the
 * offending values (a corrupt file may contain raw identifiers).
 */
export class CorruptManifestError extends Error {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super("persisted manifest failed recovery validation");
    this.name = "CorruptManifestError";
    this.issues = issues;
  }
}

/** A manifest already exists for the batchId with different content -> HTTP 409. */
export class BatchConflictError extends Error {
  readonly batchId: string;

  constructor(batchId: string) {
    super("a manifest already exists for this batchId with different business content");
    this.name = "BatchConflictError";
    this.batchId = batchId;
  }
}
