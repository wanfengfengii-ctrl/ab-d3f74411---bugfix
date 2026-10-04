import { Aliaser } from "./alias.ts";
import type { InputBatch, SharedManifest, SharedRecord } from "./types.ts";

/**
 * Convert a validated input batch into its shareable alias-only copy.
 *
 * Every patient number, accession number and internal record id is replaced by
 * its stable per-category alias. Cross references are remapped through the same
 * record-alias table, so the reference graph is preserved while no original
 * identifier survives. Measurement values pass through untouched.
 */
export function transformBatch(batch: InputBatch, aliaser: Aliaser, hash: string): SharedManifest {
  // Record aliases are resolved first so cross references resolve in one pass.
  const recordAliasById = new Map<string, string>();
  for (const record of batch.records) {
    recordAliasById.set(record.recordId, aliaser.alias("record", record.recordId));
  }

  const sharedRecords: SharedRecord[] = batch.records.map((record) => {
    const relatedAliases = record.relatedIds.map((related) => {
      const target = recordAliasById.get(related);
      if (target === undefined) {
        // Validation guarantees closure; reaching here is a programming error.
        throw new Error("internal error: unclosed cross reference during transform");
      }
      return target;
    });

    return {
      recordAlias: recordAliasById.get(record.recordId)!,
      patientAlias: aliaser.alias("patient", record.patientId),
      accessionAlias: aliaser.alias("accession", record.accessionId),
      relatedAliases,
      measurements: { ...record.measurements },
    };
  });

  return {
    batchId: batch.batchId,
    createdAt: new Date().toISOString(),
    contentHash: hash,
    records: sharedRecords,
  };
}
