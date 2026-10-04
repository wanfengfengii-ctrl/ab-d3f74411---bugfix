/**
 * Ambient global values used across the project.
 *
 * Kept separate from node-shims.d.ts on purpose: every .d.ts here is a script
 * (no top-level import/export) so its declarations are ambient globals.
 */

declare const process: any;
declare const console: any;
declare const setTimeout: any;
declare const clearTimeout: any;
declare const setInterval: any;
declare const clearInterval: any;
declare const fetch: any;
declare const structuredClone: any;
declare const AbortController: any;

/** Node Buffer is a Uint8Array at the type level; the value is loosely typed. */
declare type Buffer = Uint8Array;
declare const Buffer: any;

declare type URL = any;
declare const URL: any;
