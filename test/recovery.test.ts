import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Aliaser } from "../src/alias.ts";
import { contentHash } from "../src/canonical.ts";
import { validateSharedManifest } from "../src/sharedValidation.ts";
import { CorruptStoreError, ManifestStore } from "../src/store.ts";
import { MAX_DIAGNOSTIC_ISSUES } from "../src/diagnostics.ts";
import { transformBatch } from "../src/transform.ts";
import { CorruptManifestError } from "../src/types.ts";
import { validateBatch } from "../src/validation.ts";

const SECRET = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");

function fileNameFor(batchId: string): string {
  return createHash("sha256").update(batchId, "utf8").digest("hex") + ".json";
}

function validBody(batchId: string): Record<string, unknown> {
  return {
    batchId,
    records: [
      {
        recordId: "R-001",
        patientId: "PAT-1",
        accessionId: "ACC-1",
        relatedIds: ["R-002"],
        measurements: { tumorSizeMm: 12.5, reviewed: true, note: null },
      },
      {
        recordId: "R-002",
        patientId: "PAT-2",
        accessionId: "ACC-2",
        relatedIds: [],
        measurements: { ki67: 30 },
      },
    ],
  };
}

/**
 * The confirmed corrupt restore sample: the file name matches the current
 * hashing rule and the JSON parses, but the alias fields carry raw
 * identifiers and both contentHash and createdAt are malformed.
 */
const CORRUPT_SAMPLE = {
  batchId: "restore-batch",
  createdAt: "not-a-timestamp",
  contentHash: "not-a-valid-hash",
  records: [
    {
      recordAlias: "HOSPITAL-REC-900",
      patientAlias: "PATIENT-900",
      accessionAlias: "ACCESSION-900",
      relatedAliases: ["HOSPITAL-REC-900"],
      measurements: {},
    },
  ],
};
const CORRUPT_RAW_IDS = ["PATIENT-900", "ACCESSION-900", "HOSPITAL-REC-900"];

async function writeEntry(dir: string, fileName: string, value: unknown): Promise<void> {
  await writeFile(join(dir, fileName), typeof value === "string" ? value : JSON.stringify(value));
}

test("recovery: a valid persisted manifest survives a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "manifest-recovery-ok-"));
  const batch = validateBatch(validBody("batch-restore-ok"));
  const hash = contentHash(batch);
  const manifest = transformBatch(batch, new Aliaser(SECRET), hash);

  const first = new ManifestStore(dir);
  assert.equal((await first.create(batch.batchId, hash, manifest)).status, "created");

  const restarted = new ManifestStore(dir);
  await restarted.load();
  assert.deepEqual(restarted.get("batch-restore-ok"), manifest);
  // Idempotency/conflict semantics are intact over restored entries.
  assert.equal((await restarted.create(batch.batchId, hash, manifest)).status, "replayed");
  assert.equal((await restarted.create(batch.batchId, "different-hash", manifest)).status, "conflict");
});

test("recovery: the corrupt restore-batch sample aborts startup and is never served", async () => {
  const dir = mkdtempSync(join(tmpdir(), "manifest-recovery-corrupt-"));

  // A fully valid entry sits next to the corrupt one.
  const batch = validateBatch(validBody("batch-healthy"));
  const hash = contentHash(batch);
  const first = new ManifestStore(dir);
  await first.create(batch.batchId, hash, transformBatch(batch, new Aliaser(SECRET), hash));

  await writeEntry(dir, fileNameFor("restore-batch"), CORRUPT_SAMPLE);

  const restarted = new ManifestStore(dir);
  let failure: unknown;
  try {
    await restarted.load();
  } catch (err) {
    failure = err;
  }
  assert.ok(failure instanceof CorruptStoreError, "corrupt entry must abort the load");
  assert.deepEqual((failure as InstanceType<typeof CorruptStoreError>).files, [
    fileNameFor("restore-batch"),
  ]);

  // Diagnostics (error text + validation issues) must never contain the raw
  // identifiers embedded in the corrupt file.
  let issuesText = "";
  try {
    validateSharedManifest(CORRUPT_SAMPLE);
    assert.fail("corrupt sample must fail contract validation");
  } catch (err) {
    issuesText = JSON.stringify((err as { issues: unknown }).issues);
  }
  for (const raw of CORRUPT_RAW_IDS) {
    assert.ok(!(failure as Error).message.includes(raw), `error must not contain ${raw}`);
    assert.ok(!issuesText.includes(raw), `issues must not contain ${raw}`);
  }

  // The corrupt entry is never admitted into the index, so it cannot be
  // returned by GET even if a caller wrongly ignored the load failure.
  assert.equal(restarted.get("restore-batch"), undefined);
});

test("recovery: duplicate record aliases in a persisted entry are rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "manifest-recovery-dup-"));
  const alias = `rec-${"a".repeat(32)}`;
  const record = {
    recordAlias: alias,
    patientAlias: `pat-${"b".repeat(32)}`,
    accessionAlias: `acc-${"c".repeat(32)}`,
    relatedAliases: [],
    measurements: {},
  };
  await writeEntry(dir, fileNameFor("batch-dup-alias"), {
    batchId: "batch-dup-alias",
    createdAt: "2026-10-04T00:00:00.000Z",
    contentHash: "0".repeat(64),
    records: [record, { ...record }],
  });

  const store = new ManifestStore(dir);
  await assert.rejects(store.load(), CorruptStoreError);
  assert.equal(store.get("batch-dup-alias"), undefined);
});

test("recovery: unclosed references in a persisted entry are rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "manifest-recovery-dangling-"));
  await writeEntry(dir, fileNameFor("batch-dangling-alias"), {
    batchId: "batch-dangling-alias",
    createdAt: "2026-10-04T00:00:00.000Z",
    contentHash: "0".repeat(64),
    records: [
      {
        recordAlias: `rec-${"a".repeat(32)}`,
        patientAlias: `pat-${"b".repeat(32)}`,
        accessionAlias: `acc-${"c".repeat(32)}`,
        relatedAliases: [`rec-${"d".repeat(32)}`],
        measurements: {},
      },
    ],
  });

  const store = new ManifestStore(dir);
  await assert.rejects(store.load(), CorruptStoreError);
  assert.equal(store.get("batch-dangling-alias"), undefined);
});

test("recovery: file name must match the SHA-256 binding of its batchId", async () => {
  const dir = mkdtempSync(join(tmpdir(), "manifest-recovery-binding-"));
  const batch = validateBatch(validBody("batch-binding"));
  const hash = contentHash(batch);
  const manifest = transformBatch(batch, new Aliaser(SECRET), hash);
  // Persist the valid document under the WRONG file name.
  await writeEntry(dir, fileNameFor("some-other-batch"), manifest);

  const store = new ManifestStore(dir);
  await assert.rejects(store.load(), CorruptStoreError);
  assert.equal(store.get("batch-binding"), undefined);
});

test("recovery: a restored entry with a thousand invalid values yields bounded diagnostics", async () => {
  const dir = mkdtempSync(join(tmpdir(), "manifest-recovery-many-"));
  const keyCount = 1000;
  const measurements: Record<string, unknown> = {};
  for (let i = 0; i < keyCount; i++) {
    measurements[`m${String(i).padStart(4, "0")}`] = { secretMarker: "DO-NOT-ECHO" };
  }
  const entry = {
    batchId: "batch-many-bad",
    createdAt: "2026-10-04T00:00:00.000Z",
    contentHash: "0".repeat(64),
    records: [
      {
        recordAlias: `rec-${"a".repeat(32)}`,
        patientAlias: `pat-${"b".repeat(32)}`,
        accessionAlias: `acc-${"c".repeat(32)}`,
        relatedAliases: [],
        measurements,
      },
    ],
  };
  await writeEntry(dir, fileNameFor("batch-many-bad"), entry);

  // The shared contract validator applies the same deterministic cap.
  let contractFailure: unknown;
  try {
    validateSharedManifest(JSON.parse(JSON.stringify(entry)));
  } catch (err) {
    contractFailure = err;
  }
  assert.ok(contractFailure instanceof CorruptManifestError);
  const corruptErr = contractFailure as InstanceType<typeof CorruptManifestError>;
  assert.equal(corruptErr.issues.length, MAX_DIAGNOSTIC_ISSUES);
  assert.deepEqual(corruptErr.truncation, {
    code: "issues_truncated",
    limit: MAX_DIAGNOSTIC_ISSUES,
    reported: MAX_DIAGNOSTIC_ISSUES,
    remaining: keyCount - MAX_DIAGNOSTIC_ISSUES,
  });
  assert.ok(!JSON.stringify(corruptErr.issues).includes("DO-NOT-ECHO"));

  // Startup aborts and the recovery log line is itself bounded, carries the
  // truncation summary, and never contains the corrupt values.
  const captured: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: any }).write = (chunk: string): boolean => {
    captured.push(String(chunk));
    return true;
  };
  const store = new ManifestStore(dir);
  let failure: unknown;
  try {
    await store.load();
  } catch (err) {
    failure = err;
  } finally {
    (process.stderr as { write: any }).write = originalWrite;
  }
  assert.ok(failure instanceof CorruptStoreError, "the corrupt entry must abort load");
  assert.equal(store.get("batch-many-bad"), undefined, "it must never be admitted");

  const logLine = captured
    .map((line) => line.trim())
    .find((line) => line.includes('"event":"store_corrupt_entry"'));
  assert.ok(logLine !== undefined, "a bounded corrupt-entry diagnostic must be logged");
  if (logLine === undefined) throw new Error("unreachable");
  const logged = JSON.parse(logLine);
  assert.equal(JSON.parse(logged.issues).length, MAX_DIAGNOSTIC_ISSUES);
  assert.equal(logged.issues_remaining, keyCount - MAX_DIAGNOSTIC_ISSUES);
  assert.equal(logged.issues_limit, MAX_DIAGNOSTIC_ISSUES);
  assert.ok(!logLine.includes("DO-NOT-ECHO"), "log must not echo corrupt values");
  assert.ok(logLine.length < 64 * 1024, "recovery log line must be bounded");
});

test("recovery: syntactically broken JSON entries abort startup too", async () => {
  const dir = mkdtempSync(join(tmpdir(), "manifest-recovery-json-"));
  await writeEntry(dir, fileNameFor("batch-broken"), "{not valid json");

  const store = new ManifestStore(dir);
  await assert.rejects(store.load(), CorruptStoreError);
});

test("shared manifest contract: field set, formats and scalar measurements", () => {
  const batch = validateBatch(validBody("batch-contract"));
  const good = transformBatch(batch, new Aliaser(SECRET), contentHash(batch));
  // A manifest produced by the write path always satisfies the contract.
  assert.deepEqual(validateSharedManifest(JSON.parse(JSON.stringify(good))), good);

  const cases: Array<{ name: string; mutate: (m: any) => void; code: string }> = [
    { name: "unknown top-level field", mutate: (m) => (m.extra = 1), code: "manifest_unknown_field" },
    { name: "missing createdAt", mutate: (m) => delete m.createdAt, code: "invalid_created_at" },
    {
      name: "createdAt not a timestamp",
      mutate: (m) => (m.createdAt = "yesterday"),
      code: "invalid_created_at",
    },
    {
      name: "createdAt impossible date",
      mutate: (m) => (m.createdAt = "2026-13-40T00:00:00.000Z"),
      code: "invalid_created_at",
    },
    {
      name: "contentHash not hex",
      mutate: (m) => (m.contentHash = "zz".repeat(32)),
      code: "invalid_content_hash",
    },
    {
      name: "contentHash wrong length",
      mutate: (m) => (m.contentHash = "abcd"),
      code: "invalid_content_hash",
    },
    {
      name: "raw id in patientAlias",
      mutate: (m) => (m.records[0].patientAlias = "PATIENT-900"),
      code: "invalid_patient_alias",
    },
    {
      name: "uppercase hex alias",
      mutate: (m) => (m.records[0].recordAlias = `rec-${"A".repeat(32)}`),
      code: "invalid_record_alias",
    },
    {
      name: "unknown record field",
      mutate: (m) => (m.records[0].patientId = "PAT-1"),
      code: "record_unknown_field",
    },
    {
      name: "non-scalar measurement",
      mutate: (m) => (m.records[0].measurements.nested = { leak: 1 }),
      code: "invalid_measurement_value",
    },
    {
      name: "array measurement",
      mutate: (m) => (m.records[0].measurements.tumorSizeMm = [12.5]),
      code: "invalid_measurement_value",
    },
    {
      name: "relatedAliases not an array",
      mutate: (m) => (m.records[0].relatedAliases = "rec-1"),
      code: "related_aliases_not_array",
    },
    {
      name: "duplicate related alias",
      mutate: (m) => (m.records[0].relatedAliases = [m.records[1].recordAlias, m.records[1].recordAlias]),
      code: "duplicate_related_alias",
    },
    {
      name: "empty records",
      mutate: (m) => (m.records = []),
      code: "invalid_records",
    },
  ];

  for (const c of cases) {
    const mutated = JSON.parse(JSON.stringify(good));
    c.mutate(mutated);
    assert.throws(
      () => validateSharedManifest(mutated),
      (err: unknown) => {
        const issues = (err as { issues: { code: string }[] }).issues;
        return issues.some((i) => i.code === c.code);
      },
      c.name,
    );
  }
});
