/**
 * Ambient declarations for the Node built-in modules used by this project.
 *
 * This service ships with ZERO runtime dependencies and is executed directly by
 * Node's native TypeScript type-stripping, so no @types/node package is
 * required to run it. This file gives `tsc` just enough surface to type-check
 * the codebase strictly. All domain/business logic lives in fully typed
 * modules; only the platform boundary is intentionally `any`-typed here.
 *
 * IMPORTANT: this file must stay a SCRIPT (no top-level import/export) so its
 * `declare module` blocks remain ambient.
 */

declare module "node:crypto" {
  type Hmac = {
    update(data: unknown, encoding?: string): Hmac;
    digest(): Buffer;
    digest(encoding: string): string;
  };
  type Hash = {
    update(data: string, encoding?: string): Hash;
    digest(encoding?: string): string;
  };
  export function createHmac(algorithm: string, key: unknown): Hmac;
  export function createHash(algorithm: string): Hash;
  export function randomBytes(length: number): Buffer;
  export function randomUUID(): string;
}

declare module "node:http" {
  export function createServer(optionsOrListener?: unknown, listener?: unknown): any;
  export function request(options: unknown, callback?: unknown): any;
  export function get(options: unknown, callback?: unknown): any;
}

declare module "node:fs" {
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: unknown): void;
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, options?: unknown): void;
}

declare module "node:fs/promises" {
  export function mkdir(path: string, errors?: unknown): Promise<void>;
  export function readFile(path: string): Promise<Buffer>;
  export function readFile(path: string, encoding: string): Promise<string>;
  export function writeFile(path: string, data: unknown, options?: unknown): Promise<void>;
  export function rename(oldPath: string, newPath: string): Promise<void>;
  export function readdir(path: string): Promise<string[]>;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:child_process" {
  export function spawnSync(command: string, args?: string[], options?: unknown): any;
  export function execFileSync(command: string, args?: string[], options?: unknown): unknown;
}

declare module "node:test" {
  export function test(name: string, fn: (t?: any) => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
  export function before(fn: () => void | Promise<void>): void;
  export function after(fn: () => void | Promise<void>): void;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  const assert: any;
  export default assert;
  export const equal: any;
 export const deepEqual: any;  export const notEqual: any;
  export const ok: any;
  export const throws: any;
  export const rejects: any;
}
