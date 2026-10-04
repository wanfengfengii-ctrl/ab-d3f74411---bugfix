import { test } from "node:test";
import assert from "node:assert/strict";
import { Aliaser } from "../src/alias.ts";
import { contentHash, canonicalize } from "../src/canonical.ts";
import { transformBatch } from "../src/transform.ts";
import { validateBatch } from "../src/validation.ts";
import { ISSUES_TRUNCATED_CODE, MAX_DIAGNOSTIC_ISSUES } from "../src/diagnostics.ts";
import { ManifestStore } from "../src/store.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SECRET = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    batchId: "batch-A",
    records: [
      {
        recordId: "R-001",
        patientId: "PAT-1",
        accessionId: "ACC-1",
        relatedIds: ["R-002"],
        measurements: { tumorSizeMm: 12.5, diagnosis: "A01", reviewed: true, score: null },
      },
      {
        recordId: "R-002",
        patientId: "PAT-2",
        accessionId: "ACC-2",
        relatedIds: [],
        measurements: { ki67: 30 },
      },
    ],
    ...overrides,
  };
}

test("aliases are stable across batches and isolated across identifier classes", () => {
  const firstBatch = new Aliaser(SECRET);
  const secondBatch = new Aliaser(SECRET);

  assert.equal(
    firstBatch.alias("patient", "SAME-VALUE"),
    secondBatch.alias("patient", "SAME-VALUE"),
  );
  assert.equal(
    firstBatch.alias("accession", "SAME-VALUE"),
    secondBatch.alias("accession", "SAME-VALUE"),
  );
  assert.equal(
    firstBatch.alias("record", "SAME-VALUE"),
    secondBatch.alias("record", "SAME-VALUE"),
  );

  const patient = firstBatch.alias("patient", "SAME-VALUE");
  const accession = firstBatch.alias("accession", "SAME-VALUE");
  const record = firstBatch.alias("record", "SAME-VALUE");
  assert.notEqual(patient, accession);
  assert.notEqual(patient, record);
  assert.notEqual(accession, record);
  assert.match(patient, /^pat-[0-9a-f]{32}$/);
  assert.match(accession, /^acc-[0-9a-f]{32}$/);
  assert.match(record, /^rec-[0-9a-f]{32}$/);

  // Different deployment secrets produce different aliases.
  const otherSecret = new Aliaser(Buffer.from("fedcba9876543210fedcba9876543210", "utf8"));
  assert.notEqual(otherSecret.alias("patient", "SAME-VALUE"), patient);
});

test("transform preserves reference closure and measurement values", () => {
  const batch = validateBatch(validBody());
  const manifest = transformBatch(batch, new Aliaser(SECRET), contentHash(batch));

  const aliases = new Set(manifest.records.map((r) => r.recordAlias));
  for (const record of manifest.records) {
    for (const related of record.relatedAliases) {
      assert.ok(aliases.has(related), "every cross reference must resolve to a record alias");
    }
  }

  const r1 = manifest.records[0];
  const r2 = manifest.records[1];
  assert.deepEqual(r1.relatedAliases, [r2.recordAlias]);
  assert.deepEqual(r1.measurements, {
    tumorSizeMm: 12.5,
    diagnosis: "A01",
    reviewed: true,
    score: null,
  });
  assert.deepEqual(r2.measurements, { ki67: 30 });

  // No raw identifier survives anywhere in the shared document.
  const serialized = JSON.stringify(manifest);
  for (const raw of ["R-001", "R-002", "PAT-1", "PAT-2", "ACC-1", "ACC-2"]) {
    assert.ok(!serialized.includes(raw), `shared manifest must not contain ${raw}`);
  }
});

test("canonical hash ignores record/key ordering but detects content changes", () => {
  const reordered = validBody({
    records: [
      {
        recordId: "R-002",
        patientId: "PAT-2",
        accessionId: "ACC-2",
        relatedIds: [],
        measurements: { ki67: 30 },
      },
      {
        recordId: "R-001",
        patientId: "PAT-1",
        accessionId: "ACC-1",
        relatedIds: ["R-002"],
        measurements: { reviewed: true, score: null, diagnosis: "A01", tumorSizeMm: 12.5 },
      },
    ],
  });
  const h1 = contentHash(validateBatch(validBody()));
  const h2 = contentHash(validateBatch(reordered));
  assert.equal(h1, h2);
  assert.equal(canonicalize(validateBatch(validBody())), canonicalize(validateBatch(reordered)));

  const changed = validBody();
  (changed.records as any[])[1].measurements.ki67 = 31;
  assert.notEqual(contentHash(validateBatch(changed)), h1);

  // batchId is not part of business content.
  const otherBatchId = validBody({ batchId: "batch-B" });
  assert.equal(contentHash(validateBatch(otherBatchId)), h1);
});

test("validation rejects duplicate recordIds with 422-style failure", () => {
  const body = validBody();
  (body.records as any[]).push({
    recordId: "R-001",
    patientId: "PAT-3",
    accessionId: "ACC-3",
    relatedIds: [],
    measurements: {},
  });
  assert.throws(
    () => validateBatch(body),
    (err: unknown) => {
      const issues = (err as { issues: { code: string }[] }).issues;
      return issues.some((i) => i.code === "duplicate_record_id");
    },
  );
});

test("validation rejects dangling cross references", () => {
  const body = validBody();
  (body.records as any[])[0].relatedIds = ["R-404"];
  assert.throws(
    () => validateBatch(body),
    (err: unknown) =>
      (err as { issues: { code: string }[] }).issues.some((i) => i.code === "dangling_reference"),
  );
});

test("validation rejects illegal structures and never echoes identifier values", () => {
  const cases: Array<{ name: string; body: unknown; code: string }> = [
    { name: "not an object", body: "nope", code: "body_not_object" },
    { name: "missing batchId", body: { records: [] }, code: "invalid_batch_id" },
    { name: "records not array", body: { batchId: "b", records: {} }, code: "records_not_array" },
    { name: "empty records", body: { batchId: "b", records: [] }, code: "records_empty" },
    {
      name: "missing patientId",
      body: { batchId: "b", records: [{ recordId: "r1", accessionId: "a1", relatedIds: [] }] },
      code: "invalid_patient_id",
    },
    {
      name: "relatedIds not array",
      body: {
        batchId: "b",
        records: [{ recordId: "r1", patientId: "p1", accessionId: "a1", relatedIds: "r1" }],
      },
      code: "related_ids_not_array",
    },
    {
      name: "non scalar measurement",
      body: {
        batchId: "b",
        records: [
          {
            recordId: "r1",
            patientId: "p1",
            accessionId: "a1",
            relatedIds: [],
            measurements: { nested: { leak: 1 } },
          },
        ],
      },
      code: "measurement_invalid_type",
    },
    {
      name: "unknown field",
      body: {
        batchId: "b",
        records: [
          { recordId: "r1", patientId: "p1", accessionId: "a1", relatedIds: [], extra: 1 },
        ],
      },
      code: "record_unknown_field",
    },
  ];

  for (const c of cases) {
    assert.throws(
      () => validateBatch(c.body),
      (err: unknown) => {
        const e = err as { issues: { code: string }[] };
        return e.issues.some((i) => i.code === c.code);
      },
      c.name,
    );
  }

  // Error issues carry paths and messages only, never submitted identifier text.
  try {
    validateBatch({
      batchId: "b",
      records: [{ recordId: "SUPER-SECRET-ID", patientId: 1, accessionId: "a", relatedIds: [] }],
    });
    assert.fail("should have thrown");
  } catch (err) {
    const text = JSON.stringify((err as { issues: unknown }).issues);
    assert.ok(!text.includes("SUPER-SECRET-ID"));
  }
});

test("diagnostics are capped with a machine-readable truncation summary", () => {
  // 1000 illegal values (exactly MAX_MEASUREMENT_KEYS keys, so only the
  // value types violate the contract) must not produce 1000 issues.
  const measurements: Record<string, unknown> = {};
  for (let i = 0; i < 1000; i++) {
    measurements[`m${String(i).padStart(4, "0")}`] = [i];
  }
  const body = validBody({
    batchId: "batch-flood",
    records: [
      { recordId: "r1", patientId: "p1", accessionId: "a1", relatedIds: [], measurements },
    ],
  });

  try {
    validateBatch(body);
    assert.fail("should have thrown");
  } catch (err) {
    const issues = (err as { issues: Array<{ code: string; path: string; omitted?: number }> }).issues;
    assert.equal(issues.length, MAX_DIAGNOSTIC_ISSUES + 1);
    // Kept field-level issues still carry precise paths.
    assert.equal(issues[0].code, "measurement_invalid_type");
    assert.equal(issues[0].path, "records[0].measurements.m0000");
    // The final entry summarizes the truncated tail for machines.
    const summary = issues[issues.length - 1];
    assert.equal(summary.code, ISSUES_TRUNCATED_CODE);
    assert.equal(summary.omitted, 1000 - MAX_DIAGNOSTIC_ISSUES);
  }
});

test("diagnostics below the cap stay complete and carry no truncation summary", () => {
  const body = validBody({
    batchId: "batch-few",
    records: [
      {
        recordId: "r1",
        patientId: "p1",
        accessionId: "a1",
        relatedIds: [],
        measurements: { a: [1], b: { x: 1 }, c: [2] },
      },
    ],
  });
  try {
    validateBatch(body);
    assert.fail("should have thrown");
  } catch (err) {
    const issues = (err as { issues: Array<{ code: string; path: string }> }).issues;
    assert.equal(issues.length, 3);
    assert.deepEqual(
      issues.map((i) => i.path),
      ["records[0].measurements.a", "records[0].measurements.b", "records[0].measurements.c"],
    );
    assert.ok(!issues.some((i) => i.code === ISSUES_TRUNCATED_CODE));
  }
});

test("store: create / replay / conflict semantics, persisted to disk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "manifest-store-"));
  const store = new ManifestStore(dir);
  // Hashes use the real 64-hex shape: only contract-valid documents are ever persisted.
  const hash1 = "1".repeat(64);
  const hash2 = "2".repeat(64);
  const manifest = transformBatch(
    validateBatch(validBody()),
    new Aliaser(SECRET),
    hash1,
  );

  assert.equal((await store.create("batch-A", hash1, manifest)).status, "created");
  assert.equal((await store.create("batch-A", hash1, manifest)).status, "replayed");
  assert.equal((await store.create("batch-A", hash2, manifest)).status, "conflict");
  assert.deepEqual(store.get("batch-A")?.contentHash, hash1);

  // A fresh store over the same directory restores manifests.
  const restarted = new ManifestStore(dir);
  await restarted.load();
  assert.equal(restarted.get("batch-A")?.contentHash, hash1);
  assert.equal((await restarted.create("batch-A", hash1, manifest)).status, "replayed");
  assert.equal((await restarted.create("batch-A", hash2, manifest)).status, "conflict");
});
