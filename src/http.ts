import { createServer } from "node:http";
import { Aliaser } from "./alias.ts";
import { contentHash } from "./canonical.ts";
import { transformBatch } from "./transform.ts";
import { BATCH_ID_PATTERN, validateBatch } from "./validation.ts";
import { log } from "./log.ts";
import { ManifestStore } from "./store.ts";
import {
  BatchConflictError,
  ValidationFailed,
} from "./types.ts";

class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export interface ServerDeps {
  store: ManifestStore;
  aliasSecret: Buffer;
  maxBodyBytes: number;
}

export function createAppServer(deps: ServerDeps) {
  const { store, aliasSecret, maxBodyBytes } = deps;

  function sendJson(res: any, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    });
    res.end(body);
  }

  function readJsonBody(req: any): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;

      req.on("data", (chunk: Buffer) => {
        if (settled) return;
        size += chunk.length;
        if (size > maxBodyBytes) {
          settled = true;
          // The stream stays in flowing mode and drains itself; do NOT destroy
          // the socket, otherwise the client could never receive the 413.
          reject(new HttpError(413, "payload_too_large", "request body exceeds the size limit"));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (settled) return;
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          reject(new HttpError(400, "invalid_json", "request body is not valid JSON"));
        }
      });
      req.on("error", (err: unknown) => {
        if (!settled) reject(err);
      });
    });
  }

  async function handlePostManifest(req: any, res: any): Promise<void> {
    const raw = await readJsonBody(req);
    // validateBatch throws ValidationFailed listing only paths/rule codes,
    // never the submitted identifier values.
    const batch = validateBatch(raw);
    const hash = contentHash(batch);

    // The aliaser is request scoped; the deployment secret is what makes
    // aliases consistent across batches.
    const manifest = transformBatch(batch, new Aliaser(aliasSecret), hash);

    const outcome = await store.create(batch.batchId, hash, manifest);
    if (outcome.status === "conflict") {
      throw new BatchConflictError(batch.batchId);
    }
    // On replay the stored document (original createdAt included) is returned.
    const result = outcome.manifest;
    log.info("manifest_accepted", {
      batchId: batch.batchId,
      records: result.records.length,
      replayed: outcome.status === "replayed",
    });
    sendJson(res, outcome.status === "created" ? 201 : 200, result);
  }

  function handleGetManifest(res: any, batchId: string): void {
    if (!BATCH_ID_PATTERN.test(batchId)) {
      throw new HttpError(404, "not_found", "route not found");
    }
    const manifest = store.get(batchId);
    if (manifest === undefined) {
      throw new HttpError(404, "manifest_not_found", "no manifest exists for this batchId");
    }
    sendJson(res, 200, manifest);
  }

  const server = createServer(async (req: any, res: any) => {
    const method = req.method ?? "GET";
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      sendJson(res, 400, { error: "bad_request", message: "malformed request URL" });
      return;
    }
    const segments = url.pathname.split("/").filter((part: string) => part.length > 0);

    try {
      if (method === "GET" && (url.pathname === "/healthz" || url.pathname === "/health")) {
        sendJson(res, 200, { status: "ok" });
        return;
      }

      if (method === "POST" && segments.length === 2 && segments[0] === "api" && segments[1] === "manifests") {
        await handlePostManifest(req, res);
        return;
      }

      if (method === "GET" && segments.length === 3 && segments[0] === "api" && segments[1] === "manifests") {
        handleGetManifest(res, decodeURIComponent(segments[2]));
        return;
      }

      if (segments[0] === "api") {
        throw new HttpError(404, "not_found", "route not found");
      }
      sendJson(res, 404, { error: "not_found", message: "route not found" });
    } catch (err) {
      if (res.headersSent) return;
      if (err instanceof ValidationFailed) {
        // The issue list is capped (see diagnostics.ts); when more issues
        // exist, the machine-readable summary names the unreported count so
        // callers know the diagnostics are incomplete. The body stays bounded
        // regardless of how many values were invalid.
        sendJson(res, 422, {
          error: "validation_failed",
          issues: err.issues,
          ...(err.truncation ? { truncated: err.truncation } : {}),
        });
        log.warn("manifest_rejected", {
          issues: err.issues.length,
          issues_remaining: err.truncation?.remaining ?? 0,
        });
        return;
      }
      if (err instanceof BatchConflictError) {
        sendJson(res, 409, {
          error: "batch_conflict",
          message: "a manifest already exists for this batchId with different business content",
          batchId: err.batchId,
        });
        log.warn("manifest_conflict", { batchId: err.batchId });
        return;
      }
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.code, message: err.message });
        return;
      }
      log.error("unhandled_error", { message: err instanceof Error ? err.name : "unknown" });
      sendJson(res, 500, { error: "internal_error", message: "internal server error" });
    }
  });

  return server;
}
