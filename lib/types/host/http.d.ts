import type { IncomingMessage, ServerResponse } from 'node:http';
export declare function trustedRequest(req: IncomingMessage): boolean;
export declare function json(res: ServerResponse, status: number, body: unknown): void;
export declare function readJson(req: IncomingMessage): Promise<Record<string, unknown>>;
