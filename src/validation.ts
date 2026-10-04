import type {
  InputBatch,
  InputRecord,
  MeasurementValue,
} from "./types.ts";
import { ID_CLASSES, ValidationFailed } from "./types.ts";
import { IssueCollector } from "./diagnostics.ts";

/**
 * Strict structural validation for inbound manifests.
 *
 * Every error intentionally reports a JSON PATH and a rule, never the offending
 * identifier value: validation messages are logged and returned to clients, so
 * echoing a malformed patient/accession/record id would itself be a privacy
 * leak. The number of reported issues is bounded by the shared diagnostic cap
 * (see diagnostics.ts) so a request full of violations cannot amplify itself
 * into an unbounded 422 response.
 */

const MAX_ID_LENGTH = 256;
const MAX_BATCH_ID_LENGTH = 128;
export const MAX_RECORDS = 10_000;
export const MAX_MEASUREMENT_KEYS = 1_000;
const MAX_STRING_VALUE_LENGTH = 10_000;
export const MAX_RELATED = 1_000;

/** Conservative identifier charset; implicitly forbids whitespace and control chars. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/\-]{0,255}$/;
export const BATCH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-]{0,127}$/;
export const MEASUREMENT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.:/\-]{0,255}$/;
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidId(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_ID_LENGTH && ID_PATTERN.test(value);
}

/**
 * Pure predicate form of the measurement contract, shared with the recovery
 * path (see sharedValidation.ts): only scalars pass, strings are length
 * capped and numbers must be finite.
 */
export function isValidMeasurementValue(value: unknown): value is MeasurementValue {
  if (value === null) return true;
  const t = typeof value;
  if (t === "string") return (value as string).length <= MAX_STRING_VALUE_LENGTH;
  if (t === "boolean") return true;
  if (t === "number") return Number.isFinite(value as number);
  return false;
}

function validateMeasurementValue(
  value: unknown,
  path: string,
  issues: IssueCollector,
): value is MeasurementValue {
  if (value === null) return true;
  const t = typeof value;
  if (t === "string") {
    if ((value as string).length > MAX_STRING_VALUE_LENGTH) {
      issues.add("measurement_too_long", path, "string measurement exceeds maximum length");
      return false;
    }
    return true;
  }
  if (t === "boolean") return true;
  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      issues.add("measurement_invalid_number", path, "numeric measurement must be finite");
      return false;
    }
    return true;
  }
  issues.add(
    "measurement_invalid_type",
    path,
    "measurement value must be a string, number, boolean or null",
  );
  return false;
}

function validateRecord(raw: unknown, index: number, issues: IssueCollector): InputRecord | null {
  const path = `records[${index}]`;
  if (!isPlainObject(raw)) {
    issues.add("record_not_object", path, "each record must be a JSON object");
    return null;
  }

  const allowedFields = new Set([
    "recordId",
    "patientId",
    "accessionId",
    "relatedIds",
    "measurements",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowedFields.has(key)) {
      issues.add("record_unknown_field", `${path}.${key}`, "unexpected field in record");
    }
  }

  const recordId = raw.recordId;
  const patientId = raw.patientId;
  const accessionId = raw.accessionId;

  if (!isValidId(recordId)) {
    issues.add("invalid_record_id", `${path}.recordId`, "recordId must match the identifier format");
  }
  if (!isValidId(patientId)) {
    issues.add(
      "invalid_patient_id",
      `${path}.patientId`,
      "patientId must match the identifier format",
    );
  }
  if (!isValidId(accessionId)) {
    issues.add(
      "invalid_accession_id",
      `${path}.accessionId`,
      "accessionId must match the identifier format",
    );
  }

  // relatedIds: array of valid identifiers, de-duplicated within the record.
  const relatedIds: string[] = [];
  if (!Array.isArray(raw.relatedIds)) {
    issues.add(
      "related_ids_not_array",
      `${path}.relatedIds`,
      "relatedIds must be an array of identifiers",
    );
  } else {
    if (raw.relatedIds.length > MAX_RELATED) {
      issues.add("too_many_related", `${path}.relatedIds`, "too many related identifiers");
    }
    const seen = new Set<string>();
    raw.relatedIds.forEach((related: unknown, j: number) => {
      if (!isValidId(related)) {
        issues.add(
          "invalid_related_id",
          `${path}.relatedIds[${j}]`,
          "relatedIds entries must match the identifier format",
        );
        return;
      }
      seen.add(related);
    });
    relatedIds.push(...[...seen].sort());
  }

  // measurements: plain object of scalar values.
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
        if (validateMeasurementValue(rawMeasurements[key], mPath, issues)) {
          measurements[key] = rawMeasurements[key] as MeasurementValue;
        }
      }
    }
  }

  if (
    typeof recordId !== "string" ||
    typeof patientId !== "string" ||
    typeof accessionId !== "string"
  ) {
    return null; // structural issues already recorded
  }
  return { recordId, patientId, accessionId, relatedIds, measurements };
}

/**
 * Validate and normalize a parsed request body. Throws {@link ValidationFailed}
 * (collecting every issue found) on any structural or referential violation.
 */
export function validateBatch(raw: unknown): InputBatch {
  const issues = new IssueCollector();

  if (!isPlainObject(raw)) {
    throw new ValidationFailed([
      { code: "body_not_object", path: "$", message: "request body must be a JSON object" },
    ]);
  }

  const topAllowed = new Set(["batchId", "records"]);
  for (const key of Object.keys(raw)) {
    if (!topAllowed.has(key)) {
      issues.add("unknown_field", `$.${key}`, "unexpected top-level field");
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

  const records: InputRecord[] = [];
  if (!Array.isArray(raw.records)) {
    issues.add("records_not_array", "$.records", "records must be an array");
  } else {
    if (raw.records.length === 0) {
      issues.add("records_empty", "$.records", "at least one record is required");
    }
    if (raw.records.length > MAX_RECORDS) {
      issues.add("too_many_records", "$.records", "record count exceeds the maximum");
    }
    raw.records.forEach((item: unknown, index: number) => {
      const record = validateRecord(item, index, issues);
      if (record !== null) records.push(record);
    });
  }

  // Whole-batch rules: duplicate recordIds and dangling cross references.
  const knownRecordIds = new Set<string>();
  const seenRecordIds = new Set<string>();
  records.forEach((record, index) => {
    if (seenRecordIds.has(record.recordId)) {
      issues.add(
        "duplicate_record_id",
        `records[${index}].recordId`,
        "recordId must be unique within the batch",
      );
    }
    seenRecordIds.add(record.recordId);
    knownRecordIds.add(record.recordId);
  });
  records.forEach((record, index) => {
    record.relatedIds.forEach((related, j) => {
      if (!knownRecordIds.has(related)) {
        issues.add(
          "dangling_reference",
          `records[${index}].relatedIds[${j}]`,
          "every relatedId must reference a recordId present in the same batch",
        );
      }
    });
  });

  if (!issues.ok) throw new ValidationFailed(issues.issues);
  return { batchId, records };
}

export { ID_CLASSES };
