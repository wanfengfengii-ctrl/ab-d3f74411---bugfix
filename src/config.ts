import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { log } from "./log.ts";

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  aliasSecret: Buffer;
  maxBodyBytes: number;
}

const SECRET_FILE = "alias-secret.key";
const SECRET_MIN_BYTES = 32;

async function resolveAliasSecret(dataDir: string): Promise<Buffer> {
  const fromEnv = process.env.MANIFEST_ALIAS_SECRET;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    // Accept hex or raw UTF-8; require >= 16 bytes of key material.
    const decoded = /^[0-9a-fA-F]{32,}$/.test(fromEnv)
      ? Buffer.from(fromEnv, "hex")
      : Buffer.from(fromEnv, "utf8");
    if (decoded.length < 16) {
      throw new Error("MANIFEST_ALIAS_SECRET must provide at least 16 bytes of key material");
    }
    return decoded;
  }

  const secretPath = join(dataDir, SECRET_FILE);
  if (existsSync(secretPath)) {
    const stored = await readFile(secretPath);
    if (stored.length < SECRET_MIN_BYTES) {
      throw new Error("persisted alias secret is too short");
    }
    return stored;
  }

  const generated = randomBytes(SECRET_MIN_BYTES);
  await writeFile(secretPath, generated, { mode: 0o600 });
  log.warn("alias_secret_generated", { note: "set MANIFEST_ALIAS_SECRET in multi-replica deployments" });
  return generated;
}

export async function loadConfig(): Promise<Config> {
  const dataDir = process.env.DATA_DIR ?? "/data";
  mkdirSync(dataDir, { recursive: true });

  const aliasSecret = await resolveAliasSecret(dataDir);

  const portEnv = process.env.PORT ?? "8080";
  const port = Number(portEnv);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid PORT: ${portEnv}`);
  }

  const maxBodyBytes = Number(process.env.MAX_BODY_BYTES ?? "10485760");

  return {
    host: process.env.HOST ?? "0.0.0.0",
    port,
    dataDir,
    aliasSecret,
    maxBodyBytes,
  };
}
