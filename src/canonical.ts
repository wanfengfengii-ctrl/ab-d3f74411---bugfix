import { createHash } from "node:crypto";
import type { InputBatch, InputRecord } from "./types.ts";

/**
 * Canonical rendering of the business content of a manifest.
 *
 * The batchId is intentionally excluded: it is the storage key, not part of
 * the content compared for idempotency/conflict detection. Key order is made
 * deterministic and records are ordered by recordId so that semantically equal
 * submissions always produce the same digest.
 */
interface CanonicalRecord {
  recordId: string;
  patientId: string;
  accessionId: string;
  relatedIds: string[];
  measurements: Record<string, unknown>;
}

export function canonicalize(batch: InputBatch): string {
  const canonicalRecords: CanonicalRecord[] = batch.records
    .map((record) => normalizeRecord(record))
    .sort((a, b) => (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0));
  return stableStringify({ records: canonicalRecords });
}

function normalizeRecord(record: InputRecord): CanonicalRecord {
  const measurements: Record<string, unknown> = {};
  for (const key of Object.keys(record.measurements).sort()) {
    measurements[key] = record.measurements[key];
  }
  return {
    recordId: record.recordId,
    patientId: record.patientId,
    accessionId: record.accessionId,
    relatedIds: [...record.relatedIds].sort(),
    measurements,
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function contentHash(batch: InputBatch): string {
  return createHash("sha256").update(canonicalize(batch), "utf8").digest("hex");
}
