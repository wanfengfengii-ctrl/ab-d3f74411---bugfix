import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppServer } from "../src/http.ts";
import { ManifestStore } from "../src/store.ts";
import { MAX_DIAGNOSTIC_ISSUES } from "../src/diagnostics.ts";
import { MAX_MEASUREMENT_KEYS } from "../src/validation.ts";

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

test("a thousand invalid measurement values get a bounded truncated 422 body", async () => {
  const keyCount = 1000;
  assert.ok(keyCount <= MAX_MEASUREMENT_KEYS);
  const measurements: Record<string, unknown> = {};
  for (let i = 0; i < keyCount; i++) {
    measurements[`m${String(i).padStart(4, "0")}`] = { secretMarker: "DO-NOT-ECHO" };
  }
  const body = {
    batchId: "batch-thousand",
    records: [
      { recordId: "R-T1", patientId: "P-T1", accessionId: "A-T1", relatedIds: [], measurements },
    ],
  };
  const requestBytes = JSON.stringify(body).length;

  const { status, json } = await post(body);
  assert.equal(status, 422);
  assert.equal(json.error, "validation_failed");
  assert.ok(Array.isArray(json.issues));
  assert.equal(json.issues.length, MAX_DIAGNOSTIC_ISSUES);
  assert.deepEqual(json.truncated, {
    code: "issues_truncated",
    limit: MAX_DIAGNOSTIC_ISSUES,
    reported: MAX_DIAGNOSTIC_ISSUES,
    remaining: keyCount - MAX_DIAGNOSTIC_ISSUES,
  });
  // Deterministic field paths retained in key order.
  assert.equal(json.issues[0].path, "records[0].measurements.m0000");
  assert.equal(
    json.issues.at(-1).path,
    `records[0].measurements.m${String(MAX_DIAGNOSTIC_ISSUES - 1).padStart(4, "0")}`,
  );
  // The error response must not amplify the rejected request.
  assert.ok(JSON.stringify(json).length < requestBytes, "422 body must stay bounded");
  // No untrusted value and no raw identifier may appear.
  const text = JSON.stringify(json);
  assert.ok(!text.includes("DO-NOT-ECHO"), "422 body must not echo measurement values");
  assert.ok(!text.includes("R-T1"));
  // The whole batch is rejected, not stored.
  const res = await fetch(`${baseUrl}/api/manifests/batch-thousand`);
  assert.equal(res.status, 404);
});

test("few field errors return every exact path and no truncation marker", async () => {
  const body = {
    batchId: "batch-few-errors",
    records: [
      {
        recordId: "R-F1",
        patientId: "P-F1",
        accessionId: "A-F1",
        relatedIds: [],
        measurements: { only: ["nested-array"] },
      },
    ],
  };
  const { status, json } = await post(body);
  assert.equal(status, 422);
  assert.equal(json.issues.length, 1);
  assert.equal(json.issues[0].code, "measurement_invalid_type");
  assert.equal(json.issues[0].path, "records[0].measurements.only");
  assert.equal(json.truncated, undefined);
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
