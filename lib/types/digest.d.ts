import type { Digest } from './contracts.js';
export declare function sha256Hex(data: string | Uint8Array): Digest;
export declare function sortKeys(value: unknown): unknown;
export declare function canonicalJson(value: unknown): string;
export declare function digestOf(value: unknown): Digest;
