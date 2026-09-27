import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export * from './index.js';
export declare const name = "dsh-model-fusion";
export declare const inject: string[];
export interface Config {
    profilePath?: string;
    authorizationPath?: string;
    databasePath?: string;
    workerTools?: string[];
}
export declare const Config: z<Config>;
export declare function apply(ctx: Context, config?: Config): Promise<void>;
