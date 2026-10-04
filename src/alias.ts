import { createHmac } from "node:crypto";
import type { IdClass } from "./types.ts";

/**
 * Maps institution-local identifiers to stable, shareable aliases.
 *
 * Properties:
 *  - Deterministic: alias = HMAC-SHA256(secret, category || NUL || original),
 *    truncated to 128 bits. The same original identifier therefore receives
 *    the same alias in every batch of a deployment.
 *  - Category isolation: the class name is part of the HMAC message and each
 *    alias additionally carries a class prefix, so an identical raw value used
 *    as a patient number, an accession number and a record id yields three
 *    distinct aliases.
 *  - Irreversible: a 128-bit keyed digest cannot be feasibly reversed to the
 *    original identifier; without the deployment secret aliases cannot be
 *    linked to raw values.
 */

const PREFIX: Record<IdClass, string> = {
  patient: "pat",
  accession: "acc",
  record: "rec",
};

/** Separator between the class label and the raw value inside the HMAC message. */
const SEPARATOR = String.fromCharCode(0);

const ALIAS_HEX_LENGTH = 32; // 128 bits

export class Aliaser {
  private readonly tables: Record<IdClass, Map<string, string>> = {
    patient: new Map(),
    accession: new Map(),
    record: new Map(),
  };

  /** Reverse tables used only to detect the (astronomically unlikely) digest collision. */
  private readonly reverse: Record<IdClass, Map<string, string>> = {
    patient: new Map(),
    accession: new Map(),
    record: new Map(),
  };

  private readonly secret: Buffer;

  constructor(secret: Buffer) {
    if (!Buffer.isBuffer(secret) || secret.length < 16) {
      throw new Error("alias secret must be a Buffer of at least 16 bytes");
    }
    this.secret = secret;
  }

  private materialize(cls: IdClass, original: string): string {
    const digest = createHmac("sha256", this.secret)
      .update(cls + SEPARATOR + original, "utf8")
      .digest("hex")
      .slice(0, ALIAS_HEX_LENGTH);
    return `${PREFIX[cls]}-${digest}`;
  }

  alias(cls: IdClass, original: string): string {
    const table = this.tables[cls];
    const existing = table.get(original);
    if (existing !== undefined) return existing;

    const alias = this.materialize(cls, original);
    const previousOriginal = this.reverse[cls].get(alias);
    if (previousOriginal !== undefined && previousOriginal !== original) {
      throw new Error(`alias digest collision detected in category ${cls}`);
    }
    table.set(original, alias);
    this.reverse[cls].set(alias, original);
    return alias;
  }
}
