import type {
  MeasurementValue,
  SharedManifest,
  SharedRecord,
  ValidationIssue,
} from "./types.ts";
import { CorruptManifestError } from "./types.ts";
import {
  BATCH_ID_PATTERN,
  FORBIDDEN_KEYS,
  isPlainObject,
  isValidMeasurementValue,
  MAX_MEASUREMENT_KEYS,
  MAX_RECORDS,
  MAX_RELATED,
  MEASUREMENT_KEY_PATTERN,
} from "./validation.ts";

/**
 * Recovery-path validation for persisted shared manifests.
 *
 * The store only ever writes documents produced by transformBatch, but the
 * data volume can be restored from backups, migrated from older versions or
 * logically corrupted. Any entry that does not satisfy the CURRENT shared
 * manifest contract must be treated as corrupt: it may carry raw patient /
 * accession / record identifiers in the alias fields, malformed hashes or
 * timestamps, duplicate aliases or unclosed references, and must never be
 * served by GET nor silently overwritten.
 *
 * The contract enforced here mirrors exactly what the write path can produce:
 *  - the fixed field set {batchId, createdAt, contentHash, records}
 *  - batchId charset, ISO-8601 UTC createdAt, 64-hex contentHash
 *  - per-category alias formats (pat-/acc-/rec- + 32 lowercase hex chars)
 *  - scalar measurement values under well-formed, non-reserved keys
 *  - recordAlias unique within the manifest
 *  - relatedAliases closed over the manifest's own record aliases
 *
 * As with the inbound validator, issues report JSON paths and rule codes
 * only, never the offending values: a corrupt entry may be precisely the
 * place where raw identifiers live.
 */

const CREATED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;
const RECORD_ALIAS_PATTERN = /^rec-[0-9a-f]{32}$/;
const PATIENT_ALIAS_PATTERN = /^pat-[0-9a-f]{32}$/;
const ACCESSION_ALIAS_PATTERN = /^acc-[0-9a-f]{32}$/;

class IssueCollector {
  readonly issues: ValidationIssue[] = [];

  add(code: string, path: string, message: string): void {
    this.issues.push({ code, path, message });
  }

  get ok(): boolean {
    return this.issues.length === 0;
  }
}

function isValidCreatedAt(value: string): boolean {
  if (!CREATED_AT_PATTERN.test(value)) return false;
  const time = Date.parse(value);
  // Round-trip check rejects impossible dates (e.g. month 13) that a
  // permissive parser would otherwise roll over or accept.
  return !Number.isNaN(time) && new Date(time).toISOString() === value;
}

function validateSharedRecord(
  raw: unknown,
  index: number,
  issues: IssueCollector,
): SharedRecord | null {
  const path = `records[${index}]`;
  if (!isPlainObject(raw)) {
    issues.add("record_not_object", path, "each record must be a JSON object");
    return null;
  }

  const allowedFields = new Set([
    "recordAlias",
    "patientAlias",
    "accessionAlias",
    "relatedAliases",
    "measurements",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowedFields.has(key)) {
      issues.add("record_unknown_field", `${path}.${key}`, "unexpected field in record");
    }
  }

  const recordAlias = raw.recordAlias;
  const patientAlias = raw.patientAlias;
  const accessionAlias = raw.accessionAlias;

  if (typeof recordAlias !== "string" || !RECORD_ALIAS_PATTERN.test(recordAlias)) {
    issues.add(
      "invalid_record_alias",
      `${path}.recordAlias`,
      "recordAlias must match rec-<32 lowercase hex>",
    );
  }
  if (typeof patientAlias !== "string" || !PATIENT_ALIAS_PATTERN.test(patientAlias)) {
    issues.add(
      "invalid_patient_alias",
      `${path}.patientAlias`,
      "patientAlias must match pat-<32 lowercase hex>",
    );
  }
  if (typeof accessionAlias !== "string" || !ACCESSION_ALIAS_PATTERN.test(accessionAlias)) {
    issues.add(
      "invalid_accession_alias",
      `${path}.accessionAlias`,
      "accessionAlias must match acc-<32 lowercase hex>",
    );
  }

  // relatedAliases: array of well-formed record aliases, de-duplicated.
  const relatedAliases: string[] = [];
  if (!Array.isArray(raw.relatedAliases)) {
    issues.add(
      "related_aliases_not_array",
      `${path}.relatedAliases`,
      "relatedAliases must be an array of record aliases",
    );
  } else {
    if (raw.relatedAliases.length > MAX_RELATED) {
      issues.add("too_many_related", `${path}.relatedAliases`, "too many related aliases");
    }
    const seen = new Set<string>();
    raw.relatedAliases.forEach((related: unknown, j: number) => {
      const rPath = `${path}.relatedAliases[${j}]`;
      if (typeof related !== "string" || !RECORD_ALIAS_PATTERN.test(related)) {
        issues.add(
          "invalid_related_alias",
          rPath,
          "relatedAliases entries must match rec-<32 lowercase hex>",
        );
        return;
      }
      if (seen.has(related)) {
        issues.add("duplicate_related_alias", rPath, "relatedAliases entries must be unique");
        return;
      }
      seen.add(related);
      relatedAliases.push(related);
    });
  }

  // measurements: plain object of scalar values, same rules as the write path.
  let measurements: Record<string, MeasurementValue> = {};
  {
    const rawMeasurements = raw.measurements;
    if (!isPlainObject(rawMeasurements)) {
      issues.add(
        "measurements_not_object",
        `${path}.measurements`,
        "measurements must be a JSON object",
      );
    } else {
      const keys = Object.keys(rawMeasurements);
      if (keys.length > MAX_MEASUREMENT_KEYS) {
        issues.add("too_many_measurements", `${path}.measurements`, "too many measurement items");
      }
      for (const key of keys) {
        const mPath = `${path}.measurements.${key}`;
        if (FORBIDDEN_KEYS.has(key)) {
          issues.add("forbidden_measurement_key", mPath, "reserved measurement keys are not allowed");
          continue;
        }
        if (!MEASUREMENT_KEY_PATTERN.test(key)) {
          issues.add(
            "invalid_measurement_key",
            mPath,
            "measurement keys must be non-empty printable identifiers",
          );
          continue;
        }
        if (!isValidMeasurementValue(rawMeasurements[key])) {
          issues.add(
            "invalid_measurement_value",
            mPath,
            "measurement value must be a string, finite number, boolean or null",
          );
          continue;
        }
        measurements[key] = rawMeasurements[key] as MeasurementValue;
      }
    }
  }

  if (
    typeof recordAlias !== "string" ||
    typeof patientAlias !== "string" ||
    typeof accessionAlias !== "string"
  ) {
    return null; // structural issues already recorded
  }
  return { recordAlias, patientAlias, accessionAlias, relatedAliases, measurements };
}

/**
 * Validate a persisted shared manifest against the current contract.
 * Throws {@link CorruptManifestError} collecting every issue found; returns
 * the normalized manifest only when the document is fully contract-compliant.
 */
export function validateSharedManifest(raw: unknown): SharedManifest {
  const issues = new IssueCollector();

  if (!isPlainObject(raw)) {
    throw new CorruptManifestError([
      { code: "manifest_not_object", path: "$", message: "persisted manifest must be a JSON object" },
    ]);
  }

  const topAllowed = new Set(["batchId", "createdAt", "contentHash", "records"]);
  for (const key of Object.keys(raw)) {
    if (!topAllowed.has(key)) {
      issues.add("manifest_unknown_field", `$.${key}`, "unexpected top-level field");
    }
  }

  let batchId = "";
  if (typeof raw.batchId !== "string" || !BATCH_ID_PATTERN.test(raw.batchId)) {
    issues.add(
      "invalid_batch_id",
      "$.batchId",
      "batchId must be 1-128 chars from letters, digits, dot, underscore or dash",
    );
  } else {
    batchId = raw.batchId;
  }

  if (typeof raw.createdAt !== "string" || !isValidCreatedAt(raw.createdAt)) {
    issues.add(
      "invalid_created_at",
      "$.createdAt",
      "createdAt must be an ISO-8601 UTC timestamp with millisecond precision",
    );
  }

  if (typeof raw.contentHash !== "string" || !CONTENT_HASH_PATTERN.test(raw.contentHash)) {
    issues.add(
      "invalid_content_hash",
      "$.contentHash",
      "contentHash must be 64 lowercase hex characters",
    );
  }

  const records: SharedRecord[] = [];
  if (!Array.isArray(raw.records) || raw.records.length === 0) {
    issues.add("invalid_records", "$.records", "records must be a non-empty array");
  } else {
    if (raw.records.length > MAX_RECORDS) {
      issues.add("too_many_records", "$.records", "record count exceeds the maximum");
    }
    raw.records.forEach((item: unknown, index: number) => {
      const record = validateSharedRecord(item, index, issues);
      if (record !== null) records.push(record);
    });
  }

  // Whole-manifest rules: record aliases are unique and every cross
  // reference closes over a record alias present in the same manifest.
  const knownAliases = new Set<string>();
  records.forEach((record, index) => {
    if (knownAliases.has(record.recordAlias)) {
      issues.add(
        "duplicate_record_alias",
        `records[${index}].recordAlias`,
        "recordAlias must be unique within the manifest",
      );
    }
    knownAliases.add(record.recordAlias);
  });
  records.forEach((record, index) => {
    record.relatedAliases.forEach((related, j) => {
      if (!knownAliases.has(related)) {
        issues.add(
          "dangling_related_alias",
          `records[${index}].relatedAliases[${j}]`,
          "every relatedAlias must reference a recordAlias present in the same manifest",
        );
      }
    });
  });

  if (!issues.ok) throw new CorruptManifestError(issues.issues);
  return {
    batchId,
    createdAt: raw.createdAt as string,
    contentHash: raw.contentHash as string,
    records,
  };
}
