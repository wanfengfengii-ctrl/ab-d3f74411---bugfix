import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppServer } from "../src/http.ts";
import { MAX_DIAGNOSTIC_ISSUES, ISSUES_TRUNCATED_CODE } from "../src/diagnostics.ts";
import { ManifestStore } from "../src/store.ts";

const SECRET = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
const RAW_IDS = ["R-100", "R-200", "PAT-X", "ACC-X"];

function batchA(): any {
  return {
    batchId: "batch-A",
    records: [
      {
        recordId: "R-100",
        patientId: "PAT-X",
        accessionId: "ACC-X",
        relatedIds: ["R-200"],
        measurements: { weightMg: 4.2, site: "left-lobe", frozen: false, notes: null },
      },
      {
        recordId: "R-200",
        patientId: "PAT-Y",
        accessionId: "ACC-Y",
        relatedIds: [],
        measurements: { count: 7 },
      },
    ],
  };
}

let baseUrl: string;
let server: any;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "manifest-api-"));
  const store = new ManifestStore(dir);
  await store.load();
  server = createAppServer({ store, aliasSecret: SECRET, maxBodyBytes: 1_000_000 });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function post(body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}/api/manifests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test("POST valid manifest returns an alias-only, reference-closed shared copy", async () => {
  const { status, json } = await post(batchA());
  assert.equal(status, 201);
  assert.equal(json.batchId, "batch-A");
  assert.match(json.contentHash, /^[0-9a-f]{64}$/);
  assert.equal(json.records.length, 2);

  const serialized = JSON.stringify(json);
  for (const raw of RAW_IDS) {
    assert.ok(!serialized.includes(raw), `response must not echo raw identifier ${raw}`);
  }

  const recordAliases = new Set(json.records.map((r: any) => r.recordAlias));
  for (const record of json.records) {
    assert.match(record.recordAlias, /^rec-[0-9a-f]{32}$/);
    assert.match(record.patientAlias, /^pat-[0-9a-f]{32}$/);
    assert.match(record.accessionAlias, /^acc-[0-9a-f]{32}$/);
    for (const related of record.relatedAliases) {
      assert.ok(recordAliases.has(related), "cross references must point to record aliases");
    }
  }
  assert.deepEqual(json.records[0].relatedAliases, [json.records[1].recordAlias]);
  assert.deepEqual(json.records[0].measurements, {
    weightMg: 4.2,
    site: "left-lobe",
    frozen: false,
    notes: null,
  });
  assert.deepEqual(json.records[1].measurements, { count: 7 });
});

test("retrying the same batchId with identical content replays the original result", async () => {
  const first = await post(batchA());
  assert.equal(first.status, 200); // already created by the previous test
  const fetched = await fetch(`${baseUrl}/api/manifests/batch-A`);
  assert.equal(fetched.status, 200);
  const stored = await fetched.json();
  assert.deepEqual(stored, first.json);
});

test("same batchId with different business content is blocked with 409", async () => {
  const conflicting = batchA();
  (conflicting.records as any[])[1].measurements.count = 8;
  const { status, json } = await post(conflicting);
  assert.equal(status, 409);
  assert.equal(json.error, "batch_conflict");
  // Conflict response must not leak identifiers either.
  assert.ok(!JSON.stringify(json).includes("R-100"));
});

test("duplicate recordIds reject the whole batch with 422", async () => {
  const body: any = {
    batchId: "batch-dup",
    records: [
      batchA().records[0],
      { recordId: "R-100", patientId: "PAT-Z", accessionId: "ACC-Z", relatedIds: [], measurements: {} },
    ],
  };
  const { status, json } = await post(body);
  assert.equal(status, 422);
  assert.equal(json.error, "validation_failed");
  assert.ok(json.issues.some((i: any) => i.code === "duplicate_record_id"));
  assert.ok(!JSON.stringify(json).includes("R-100"), "422 body must not echo identifier values");
});

test("dangling references reject the whole batch with 422 and nothing is stored", async () => {
  const body = {
    batchId: "batch-dangling",
    records: [
      { recordId: "R-900", patientId: "PAT-9", accessionId: "ACC-9", relatedIds: ["R-404"], measurements: {} },
    ],
  };
  const { status, json } = await post(body);
  assert.equal(status, 422);
  assert.ok(json.issues.some((i: any) => i.code === "dangling_reference"));

  const res = await fetch(`${baseUrl}/api/manifests/batch-dangling`);
  assert.equal(res.status, 404);
});

test("malformed JSON yields 400 and unknown batch yields 404", async () => {
  const bad = await post("{not json");
  assert.equal(bad.status, 400);
  const res = await fetch(`${baseUrl}/api/manifests/does-not-exist`);
  assert.equal(res.status, 404);
  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
});

test("an oversized body is rejected with 413 and still produces a response", async () => {
  const oversized = {
    batchId: "batch-huge",
    records: [
      {
        recordId: "R-big",
        patientId: "P-big",
        accessionId: "A-big",
        relatedIds: [],
        measurements: { blob: "z".repeat(1_500_000) },
      },
    ],
  };
  const { status } = await post(oversized);
  assert.equal(status, 413);
});

test("a flood of illegal measurement values yields a bounded 422 with a truncation summary", async () => {
  // 1000 keys = exactly MAX_MEASUREMENT_KEYS, so only the value types violate
  // the contract; the request itself is small (~23 KB).
  const measurements: Record<string, unknown> = {};
  for (let i = 0; i < 1000; i++) {
    measurements[`m${String(i).padStart(4, "0")}`] = { nested: i };
  }
  const body = {
    batchId: "batch-flood",
    records: [
      {
        recordId: "R-flood",
        patientId: "P-flood",
        accessionId: "A-flood",
        relatedIds: [],
        measurements,
      },
    ],
  };
  const requestText = JSON.stringify(body);
  const res = await fetch(`${baseUrl}/api/manifests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: requestText,
  });
  assert.equal(res.status, 422);
  const responseText = await res.text();
  const json = JSON.parse(responseText);
  assert.equal(json.error, "validation_failed");

  // The diagnostics are bounded: 1000 violations collapse into the capped
  // field-level list plus one machine-readable truncation summary, and the
  // response no longer amplifies the request.
  assert.ok(
    json.issues.length <= MAX_DIAGNOSTIC_ISSUES + 1,
    `expected at most ${MAX_DIAGNOSTIC_ISSUES + 1} issues, got ${json.issues.length}`,
  );
  assert.ok(
    responseText.length < requestText.length,
    "the 422 body must stay smaller than the rejected request",
  );

  // Kept field-level issues still carry precise paths, and the key-count
  // boundary (1000 keys allowed) is untouched.
  assert.equal(json.issues[0].path, "records[0].measurements.m0000");
  assert.equal(json.issues[0].code, "measurement_invalid_type");
  assert.ok(!json.issues.some((i: any) => i.code === "too_many_measurements"));

  // The final entry is the machine-readable truncation summary.
  const summary = json.issues[json.issues.length - 1];
  assert.equal(summary.code, ISSUES_TRUNCATED_CODE);
  assert.equal(summary.omitted, 1000 - MAX_DIAGNOSTIC_ISSUES);

  // Diagnostics must not echo untrusted values, and nothing is stored.
  assert.ok(!responseText.includes("nested"), "422 body must not echo measurement values");
  const missing = await fetch(`${baseUrl}/api/manifests/batch-flood`);
  assert.equal(missing.status, 404);
});

test("a small number of field errors keeps every precise path without truncation", async () => {
  const { status, json } = await post({
    batchId: "batch-few-errors",
    records: [
      {
        recordId: "R-few",
        patientId: 42, // invalid_patient_id
        accessionId: "A-few",
        relatedIds: [],
        measurements: { bad: { x: 1 } }, // measurement_invalid_type
      },
    ],
  });
  assert.equal(status, 422);
  assert.equal(json.issues.length, 2, "every field error must be reported precisely");
  const paths = json.issues.map((i: any) => i.path).sort();
  assert.deepEqual(paths, ["records[0].measurements.bad", "records[0].patientId"]);
  assert.ok(!json.issues.some((i: any) => i.code === ISSUES_TRUNCATED_CODE));
});

test("aliases stay consistent across batches while identifier classes stay isolated", async () => {
  const second = {
    batchId: "batch-B",
    records: [
      // Same patient/accession values as batch A's first record.
      { recordId: "R-300", patientId: "PAT-X", accessionId: "ACC-X", relatedIds: [], measurements: {} },
      { recordId: "DUP", patientId: "DUP", accessionId: "DUP", relatedIds: [], measurements: {} },
    ],
  };
  const { status, json } = await post(second);
  assert.equal(status, 201);

  const first = (await fetch(`${baseUrl}/api/manifests/batch-A`).then((r: any) => r.json())).records[0];
  assert.equal(json.records[0].patientAlias, first.patientAlias);
  assert.equal(json.records[0].accessionAlias, first.accessionAlias);

  // "DUP" used in all three classes must produce three distinct aliases.
  const dup = json.records[1];
  assert.notEqual(dup.recordAlias, dup.patientAlias);
  assert.notEqual(dup.recordAlias, dup.accessionAlias);
  assert.notEqual(dup.patientAlias, dup.accessionAlias);
});
