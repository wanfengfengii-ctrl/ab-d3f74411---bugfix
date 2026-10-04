import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IssueTruncation, SharedManifest, ValidationIssue } from "./types.ts";
import { CorruptManifestError } from "./types.ts";
import { validateSharedManifest } from "./sharedValidation.ts";
import { log } from "./log.ts";

/**
 * Persistent manifest store.
 *
 * Only alias-only {@link SharedManifest} documents are ever written to disk;
 * raw identifiers exist solely in the short-lived request handling scope.
 * Files are named by SHA-256(batchId) so storage paths contain no client
 * supplied identifier text, and writes are atomic (temp file + rename).
 *
 * Recovery is fail-closed: a data volume may have been restored from a
 * backup, migrated from an older version or logically corrupted, so every
 * persisted entry is re-validated against the full current shared-manifest
 * contract (structure, alias/hash/timestamp formats, scalar measurements,
 * record-alias uniqueness, reference closure and the file-name <-> batchId
 * binding) before it is trusted. Any corrupt entry is reported via
 * diagnostics that contain only the hashed file name, rule codes and JSON
 * paths — never file contents — and aborts startup. A corrupt entry is
 * therefore never served by GET and never treated as absent, so a batchId
 * with a corrupt entry cannot be silently overwritten either.
 */

export type CreateOutcome =
  | { status: "created"; manifest: SharedManifest }
  | { status: "replayed"; manifest: SharedManifest }
  | { status: "conflict" };

/**
 * Startup aborts when one or more persisted entries fail recovery
 * validation. Carries only the (hashed) file names, never entry contents.
 */
export class CorruptStoreError extends Error {
  readonly files: string[];

  constructor(files: string[]) {
    super(
      `refusing to start: ${files.length} persisted manifest(s) failed recovery validation: ` +
        files.join(", "),
    );
    this.name = "CorruptStoreError";
    this.files = files;
  }
}

export class ManifestStore {
  private readonly manifests = new Map<string, SharedManifest>();
  /** Serializes concurrent creates targeting the same batchId. */
  private readonly locks = new Map<string, Promise<unknown>>();

  private readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true });
  }

  private fileName(batchId: string): string {
    return createHash("sha256").update(batchId, "utf8").digest("hex") + ".json";
  }

  async load(): Promise<void> {
    const entries = await readdir(this.dataDir);
    const corrupt: Array<{
      file: string;
      issues: ValidationIssue[];
      truncation: IssueTruncation | null;
    }> = [];
    let count = 0;
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".json")) continue;
      const verdict = await this.inspectEntry(entry);
      if (verdict.issues.length > 0) {
        corrupt.push({ file: entry, issues: verdict.issues, truncation: verdict.truncation });
      } else {
        count++;
      }
    }
    // Report every corrupt entry before aborting so a single restart cycle
    // surfaces all of them. The diagnostics contain only hashed file names,
    // rule codes and JSON paths — corrupt content itself is never logged —
    // and the issue list per entry is capped (see diagnostics.ts), with a
    // truncation summary naming how many further issues remain unreported.
    for (const entry of corrupt) {
      log.error("store_corrupt_entry", {
        file: entry.file,
        issues: JSON.stringify(entry.issues),
        ...(entry.truncation
          ? {
              issues_remaining: entry.truncation.remaining,
              issues_limit: entry.truncation.limit,
            }
          : {}),
      });
    }
    if (corrupt.length > 0) {
      throw new CorruptStoreError(corrupt.map((entry) => entry.file));
    }
    log.info("store_loaded", { manifests: count });
  }

  /**
   * Validate one persisted entry. Returns the list of contract violations
   * (empty when the entry is trustworthy) and, when the issue cap was hit, a
   * truncation summary; only fully valid entries are admitted into the
   * in-memory index.
   */
  private async inspectEntry(entry: string): Promise<{
    issues: ValidationIssue[];
    truncation: IssueTruncation | null;
  }> {
    const readIssue = (code: string, path: string, message: string): {
      issues: ValidationIssue[];
      truncation: IssueTruncation | null;
    } => ({ issues: [{ code, path, message }], truncation: null });

    let raw: string;
    try {
      raw = await readFile(join(this.dataDir, entry), "utf8");
    } catch {
      return readIssue("unreadable_entry", "$", "persisted manifest could not be read");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return readIssue("invalid_json", "$", "persisted manifest is not valid JSON");
    }

    let manifest: SharedManifest;
    try {
      manifest = validateSharedManifest(parsed);
    } catch (err) {
      if (err instanceof CorruptManifestError) {
        return { issues: err.issues, truncation: err.truncation };
      }
      throw err;
    }

    // The storage key is part of the contract: the file name must be the
    // SHA-256 of the batchId it claims to hold.
    if (entry !== this.fileName(manifest.batchId)) {
      return readIssue(
        "batch_id_file_mismatch",
        "$.batchId",
        "batchId does not match the persisted file name binding",
      );
    }

    this.manifests.set(manifest.batchId, manifest);
    return { issues: [], truncation: null };
  }

  get(batchId: string): SharedManifest | undefined {
    return this.manifests.get(batchId);
  }

  /**
   * Idempotent create.
   *  - first submission for the batchId: persist and return "created"
   *  - identical business content (same content hash): return "replayed"
   *  - different content for the same batchId: return "conflict" (HTTP 409)
   */
  create(batchId: string, contentDigest: string, manifest: SharedManifest): Promise<CreateOutcome> {
    const prior = this.locks.get(batchId) ?? Promise.resolve();
    const result = prior.then(() => this.createInner(batchId, contentDigest, manifest));
    this.locks.set(
      batchId,
      result.catch(() => undefined),
    );
    return result;
  }

  private async createInner(
    batchId: string,
    contentDigest: string,
    manifest: SharedManifest,
  ): Promise<CreateOutcome> {
    const existing = this.manifests.get(batchId);
    if (existing !== undefined) {
      return existing.contentHash === contentDigest
        ? { status: "replayed", manifest: existing }
        : { status: "conflict" };
    }

    const target = join(this.dataDir, this.fileName(batchId));
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(manifest), { mode: 0o600 });
    await rename(tmp, target);
    this.manifests.set(batchId, manifest);
    return { status: "created", manifest };
  }
}
