import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Aliaser } from "../src/alias.ts";
import { contentHash } from "../src/canonical.ts";
import { ISSUES_TRUNCATED_CODE, MAX_DIAGNOSTIC_ISSUES } from "../src/diagnostics.ts";
import { validateSharedManifest } from "../src/sharedValidation.ts";
import { CorruptStoreError, ManifestStore } from "../src/store.ts";
import { transformBatch } from "../src/transform.ts";
import { validateBatch } from "../src/validation.ts";

/**
 * One-shot verification entrypoint (the `verify` compose service).
 *
 * Runs after the API is healthy and aggregates all results into a single exit
 * code (0 = every stage passed, 1 = one or more stages failed):
 *   1. code tests (node:test unit + HTTP integration suites)
 *   2. TypeScript build (strict tsc type-check)
 *   3. recovery safety: valid manifests survive a restart, while corrupt
 *      restored entries (the restore-batch sample, duplicate aliases,
 *      unclosed references, diagnostic floods) abort the load without
 *      leaking raw identifiers and with bounded diagnostics
 *   4. submit/query smoke against the live API, including:
 *      - first submission -> 201, identical retry -> 200 with the same result
 *      - GET returns the stored document
 *      - cross-batch alias stability and per-category isolation
 *      - 409 on conflicting content, 422 on an invalid whole batch
 *      - a 1000-violation batch -> bounded 422 with a truncation summary
 *      - no raw identifier value ever appears in a response
 */

const API_BASE_URL = process.env.API_BASE_URL ?? "http://api:8080";
const APP_DIR = process.env.APP_DIR ?? "/app";

function runCommand(name: string, command: string, args: string[]): boolean {
  process.stdout.write(`\n=== verify: ${name} ===\n`);
  const result = spawnSync(command, args, { cwd: APP_DIR, stdio: "inherit" });
  if (result.error) {
    process.stderr.write(`--- verify: ${name} FAILED: ${String(result.error.message)}\n`);
    return false;
  }
  if (result.status !== 0) {
    process.stderr.write(`--- verify: ${name} FAILED: ${command} exited with ${result.status}\n`);
    return false;
  }
  process.stdout.write(`--- verify: ${name} OK\n`);
  return true;
}

async function waitForHealthy(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not started";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${API_BASE_URL}/healthz`);
      if (res.ok) return;
      lastError = `status ${res.status}`;
    } catch (err) {
      lastError = (err as Error).message;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`API did not become healthy in time (${lastError})`);
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function postJson(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function getJson(path: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${API_BASE_URL}${path}`);
  return { status: res.status, json: await res.json() };
}

const RAW_VALUES = ["SMOKE-R1", "SMOKE-R2", "SMOKE-R3", "SMOKE-R9", "SMOKE-P1", "SMOKE-P2", "SMOKE-P9", "SMOKE-A1", "SMOKE-A2", "SMOKE-A9", "DUPVAL", "SMOKE-X", "SMOKE-PX", "SMOKE-PY", "SMOKE-AX", "SMOKE-AY", "GHOST", "SMOKE-RF", "SMOKE-PF", "SMOKE-AF"];

function assertNoRawLeak(label: string, value: unknown): void {
  const text = JSON.stringify(value);
  for (const raw of RAW_VALUES) {
    assert(!text.includes(raw), `${label} leaks raw identifier ${raw}`);
  }
}

const batchOne = {
  batchId: "smoke-batch-1",
  records: [
    {
      recordId: "SMOKE-R1",
      patientId: "SMOKE-P1",
      accessionId: "SMOKE-A1",
      relatedIds: ["SMOKE-R2"],
      measurements: { tumorSizeMm: 11.5, marker: "her2", positive: true, residual: null },
    },
    {
      recordId: "SMOKE-R2",
      patientId: "SMOKE-P2",
      accessionId: "SMOKE-A2",
      relatedIds: [],
      measurements: { count: 3 },
    },
  ],
};

async function runSmoke(): Promise<boolean> {
  process.stdout.write("\n=== verify: submit/query smoke ===\n");
  try {
    await waitForHealthy();
    process.stdout.write("verify: API healthy\n");

    // 1. First submission -> 201 alias-only closed copy.
    const created = await postJson("/api/manifests", batchOne);
    assert(created.status === 201, `expected 201, got ${created.status}`);
    assertNoRawLeak("create response", created.json);
    const createdText = JSON.stringify(created.json);
    for (const prefix of ["rec-", "pat-", "acc-"]) {
      assert(createdText.includes(prefix), `create response missing ${prefix} aliases`);
    }
    assert(
      JSON.stringify(created.json.records[0].measurements) ===
        JSON.stringify({ tumorSizeMm: 11.5, marker: "her2", positive: true, residual: null }),
      "measurements must be preserved verbatim",
    );
    const aliases = new Set(created.json.records.map((r: any) => r.recordAlias));
    assert(
      created.json.records[0].relatedAliases.length === 1 &&
        aliases.has(created.json.records[0].relatedAliases[0]),
      "cross references must resolve to record aliases",
    );

    // 2. Identical retry -> 200 with the ORIGINAL result.
    const retry = await postJson("/api/manifests", batchOne);
    assert(retry.status === 200, `expected 200 on retry, got ${retry.status}`);
    assert(
      JSON.stringify(retry.json) === JSON.stringify(created.json),
      "retry must return the original stored result",
    );

    // 3. GET returns the same document.
    const fetched = await getJson("/api/manifests/smoke-batch-1");
    assert(fetched.status === 200, `expected 200 on GET, got ${fetched.status}`);
    assert(
      JSON.stringify(fetched.json) === JSON.stringify(created.json),
      "GET must return the stored manifest",
    );

    // 4. Cross-batch alias stability + category isolation.
    const batchTwo = {
      batchId: "smoke-batch-2",
      records: [
        { recordId: "SMOKE-R3", patientId: "SMOKE-P1", accessionId: "SMOKE-A1", relatedIds: [], measurements: {} },
        { recordId: "DUPVAL", patientId: "DUPVAL", accessionId: "DUPVAL", relatedIds: [], measurements: {} },
      ],
    };
    const second = await postJson("/api/manifests", batchTwo);
    assert(second.status === 201, `expected 201 for second batch, got ${second.status}`);
    assertNoRawLeak("second batch response", second.json);
    assert(
      second.json.records[0].patientAlias === created.json.records[0].patientAlias,
      "same patient id across batches must map to the same alias",
    );
    assert(
      second.json.records[0].accessionAlias === created.json.records[0].accessionAlias,
      "same accession id across batches must map to the same alias",
    );
    const dup = second.json.records[1];
    assert(
      dup.recordAlias !== dup.patientAlias &&
        dup.recordAlias !== dup.accessionAlias &&
        dup.patientAlias !== dup.accessionAlias,
      "identifier classes must be isolated even for identical raw values",
    );

    // 5. Conflict: same batchId, different business content -> 409.
    const conflicting = JSON.parse(JSON.stringify(batchOne));
    conflicting.records[1].measurements.count = 4;
    const conflict = await postJson("/api/manifests", conflicting);
    assert(conflict.status === 409, `expected 409, got ${conflict.status}`);
    assertNoRawLeak("conflict response", conflict.json);

    // 6. Invalid structure (duplicate recordId) -> whole batch rejected 422.
    const invalid = {
      batchId: "smoke-batch-invalid",
      records: [
        { recordId: "SMOKE-X", patientId: "SMOKE-PX", accessionId: "SMOKE-AX", relatedIds: [], measurements: {} },
        { recordId: "SMOKE-X", patientId: "SMOKE-PY", accessionId: "SMOKE-AY", relatedIds: [], measurements: {} },
      ],
    };
    const rejected = await postJson("/api/manifests", invalid);
    assert(rejected.status === 422, `expected 422, got ${rejected.status}`);
    assertNoRawLeak("validation response", rejected.json);
    const missing = await getJson("/api/manifests/smoke-batch-invalid");
    assert(missing.status === 404, "rejected batch must not be stored");

    // 7. Dangling reference -> 422.
    const dangling = {
      batchId: "smoke-batch-dangling",
      records: [
        { recordId: "SMOKE-R9", patientId: "SMOKE-P9", accessionId: "SMOKE-A9", relatedIds: ["GHOST"], measurements: {} },
      ],
    };
    const danglingRes = await postJson("/api/manifests", dangling);
    assert(danglingRes.status === 422, `expected 422 for dangling reference, got ${danglingRes.status}`);
    assertNoRawLeak("dangling response", danglingRes.json);

    // 8. Diagnostic flood: 1000 illegal measurement values (exactly the
    //    measurement-key limit, so only the value types violate the
    //    contract) -> bounded 422 with a machine-readable truncation summary.
    const floodMeasurements: Record<string, unknown> = {};
    for (let i = 0; i < 1000; i++) {
      floodMeasurements[`m${String(i).padStart(4, "0")}`] = { nested: i };
    }
    const flood = {
      batchId: "smoke-batch-flood",
      records: [
        { recordId: "SMOKE-RF", patientId: "SMOKE-PF", accessionId: "SMOKE-AF", relatedIds: [], measurements: floodMeasurements },
      ],
    };
    const floodRequestText = JSON.stringify(flood);
    const floodRes = await fetch(`${API_BASE_URL}/api/manifests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: floodRequestText,
    });
    assert(floodRes.status === 422, `expected 422 for the flood batch, got ${floodRes.status}`);
    const floodText = await floodRes.text();
    const floodJson = JSON.parse(floodText);
    assert(floodJson.error === "validation_failed", "flood batch must fail validation");
    assertNoRawLeak("flood response", floodJson);
    assert(
      Array.isArray(floodJson.issues) && floodJson.issues.length <= MAX_DIAGNOSTIC_ISSUES + 1,
      `flood diagnostics must be bounded to ${MAX_DIAGNOSTIC_ISSUES} issues plus a summary`,
    );
    assert(
      floodText.length < floodRequestText.length,
      "the 422 body must not amplify the rejected request",
    );
    assert(
      floodJson.issues[0].path === "records[0].measurements.m0000",
      "kept field-level issues must carry precise paths",
    );
    const floodSummary = floodJson.issues[floodJson.issues.length - 1];
    assert(
      floodSummary.code === ISSUES_TRUNCATED_CODE &&
        typeof floodSummary.omitted === "number" &&
        floodSummary.omitted > 0,
      "a machine-readable truncation summary must report the omitted issue count",
    );
    const floodMissing = await getJson("/api/manifests/smoke-batch-flood");
    assert(floodMissing.status === 404, "rejected flood batch must not be stored");

    process.stdout.write("--- verify: submit/query smoke OK\n");
    return true;
  } catch (err) {
    process.stderr.write(`--- verify: submit/query smoke FAILED: ${(err as Error)?.message ?? String(err)}\n`);
    return false;
  }
}

/**
 * Recovery-path checks, run against local throwaway data dirs (the live API
 * keeps serving valid traffic, so corrupt-volume scenarios are exercised
 * here instead of by poisoning the shared volume):
 *   - a valid persisted manifest is queryable after a restart
 *   - the confirmed corrupt restore-batch sample aborts the load, is never
 *     served, and its raw identifiers never appear in diagnostics
 *   - duplicate record aliases and unclosed references are rejected
 */
async function runRecoverySmoke(): Promise<boolean> {
  process.stdout.write("\n=== verify: recovery safety ===\n");
  const RECOVERY_RAW_IDS = ["PATIENT-900", "ACCESSION-900", "HOSPITAL-REC-900"];
  const fileNameFor = (batchId: string): string =>
    createHash("sha256").update(batchId, "utf8").digest("hex") + ".json";
  const secret = Buffer.from("verify-recovery-secret-0123456789ab", "utf8");

  const expectCorruptLoad = async (dir: string, batchId: string): Promise<Error> => {
    const store = new ManifestStore(dir);
    try {
      await store.load();
    } catch (err) {
      assert(err instanceof CorruptStoreError, "corrupt entries must abort the load");
      assert(
        store.get(batchId) === undefined,
        "a corrupt entry must never be admitted into the index",
      );
      return err as Error;
    }
    throw new Error(`corrupt entry for ${batchId} did not abort the load`);
  };

  try {
    // 1. A valid manifest round-trips through a restart.
    const okDir = mkdtempSync(join(tmpdir(), "verify-recovery-ok-"));
    const batch = validateBatch({
      batchId: "verify-recovery-ok",
      records: [
        {
          recordId: "SMOKE-R1",
          patientId: "SMOKE-P1",
          accessionId: "SMOKE-A1",
          relatedIds: [],
          measurements: { tumorSizeMm: 11.5 },
        },
      ],
    });
    const hash = contentHash(batch);
    const manifest = transformBatch(batch, new Aliaser(secret), hash);
    const first = new ManifestStore(okDir);
    assert((await first.create(batch.batchId, hash, manifest)).status === "created", "create failed");
    const restored = new ManifestStore(okDir);
    await restored.load();
    assert(
      JSON.stringify(restored.get(batch.batchId)) === JSON.stringify(manifest),
      "a valid manifest must be queryable after a restart",
    );
    assert(
      (await restored.create(batch.batchId, hash, manifest)).status === "replayed" &&
        (await restored.create(batch.batchId, "other-hash", manifest)).status === "conflict",
      "replay/conflict semantics must hold over restored entries",
    );

    // 2. The confirmed corrupt sample: hash-rule file name, valid JSON, but
    // raw identifiers in the alias fields and malformed hash/timestamp.
    const corruptDir = mkdtempSync(join(tmpdir(), "verify-recovery-corrupt-"));
    await writeFile(
      join(corruptDir, fileNameFor("restore-batch")),
      JSON.stringify({
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
      }),
    );
    const failure = await expectCorruptLoad(corruptDir, "restore-batch");
    for (const raw of RECOVERY_RAW_IDS) {
      assert(!failure.message.includes(raw), `diagnostics must not contain raw identifier ${raw}`);
    }

    // 3. Duplicate record aliases in a restored entry are rejected.
    const dupDir = mkdtempSync(join(tmpdir(), "verify-recovery-dup-"));
    const dupRecord = {
      recordAlias: `rec-${"a".repeat(32)}`,
      patientAlias: `pat-${"b".repeat(32)}`,
      accessionAlias: `acc-${"c".repeat(32)}`,
      relatedAliases: [],
      measurements: {},
    };
    await writeFile(
      join(dupDir, fileNameFor("verify-recovery-dup")),
      JSON.stringify({
        batchId: "verify-recovery-dup",
        createdAt: "2026-10-04T00:00:00.000Z",
        contentHash: "0".repeat(64),
        records: [dupRecord, dupRecord],
      }),
    );
    await expectCorruptLoad(dupDir, "verify-recovery-dup");

    // 4. Unclosed cross references in a restored entry are rejected.
    const danglingDir = mkdtempSync(join(tmpdir(), "verify-recovery-dangling-"));
    await writeFile(
      join(danglingDir, fileNameFor("verify-recovery-dangling")),
      JSON.stringify({
        batchId: "verify-recovery-dangling",
        createdAt: "2026-10-04T00:00:00.000Z",
        contentHash: "0".repeat(64),
        records: [{ ...dupRecord, relatedAliases: [`rec-${"d".repeat(32)}`] }],
      }),
    );
    await expectCorruptLoad(danglingDir, "verify-recovery-dangling");

    // 5. A restored entry carrying 1000 illegal measurement values is
    //    rejected with bounded diagnostics: a capped issue list ending in a
    //    machine-readable truncation summary, so the recovery log stays
    //    small no matter how many violations the entry contains.
    const floodDir = mkdtempSync(join(tmpdir(), "verify-recovery-flood-"));
    const floodMeasurements: Record<string, unknown> = {};
    for (let i = 0; i < 1000; i++) {
      floodMeasurements[`m${String(i).padStart(4, "0")}`] = { nested: i };
    }
    const floodManifest = {
      batchId: "verify-recovery-flood",
      createdAt: "2026-10-04T00:00:00.000Z",
      contentHash: "0".repeat(64),
      records: [{ ...dupRecord, measurements: floodMeasurements }],
    };
    await writeFile(
      join(floodDir, fileNameFor("verify-recovery-flood")),
      JSON.stringify(floodManifest),
    );
    await expectCorruptLoad(floodDir, "verify-recovery-flood");
    let floodIssues: Array<{ code: string; omitted?: number }> = [];
    try {
      validateSharedManifest(floodManifest);
    } catch (err) {
      floodIssues = (err as { issues?: typeof floodIssues }).issues ?? [];
    }
    assert(floodIssues.length > 0, "the flood manifest must fail contract validation");
    assert(
      floodIssues.length <= MAX_DIAGNOSTIC_ISSUES + 1,
      "recovery diagnostics must be bounded",
    );
    const floodSummary = floodIssues[floodIssues.length - 1];
    assert(
      floodSummary.code === ISSUES_TRUNCATED_CODE &&
        typeof floodSummary.omitted === "number" &&
        floodSummary.omitted > 0,
      "recovery diagnostics must end in a machine-readable truncation summary",
    );

    process.stdout.write("--- verify: recovery safety OK\n");
    return true;
  } catch (err) {
    process.stderr.write(
      `--- verify: recovery safety FAILED: ${(err as Error)?.message ?? String(err)}\n`,
    );
    return false;
  }
}

async function main(): Promise<void> {
  // Isolated data dir for the in-process servers spawned by the test suites.
  if (!process.env.DATA_DIR) {
    const dir = "/tmp/manifest-verify-data";
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    process.env.DATA_DIR = dir;
  }

  const results: boolean[] = [
    runCommand("code tests", process.execPath, [
      "--experimental-strip-types",
      "--test",
      "test/manifest.test.ts",
      "test/api.test.ts",
      "test/recovery.test.ts",
    ]),
    runCommand("typescript build", process.execPath, [
      "node_modules/typescript/bin/tsc",
      "-p",
      "tsconfig.json",
    ]),
    await runRecoverySmoke(),
    await runSmoke(),
  ];

  const failed = results.filter((ok) => !ok).length;
  process.stdout.write(`\nverify summary: ${results.length - failed}/${results.length} stages passed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
