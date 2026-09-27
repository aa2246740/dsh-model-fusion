import type { PromptBundle } from './profile/resolve.js';
export declare function defaultPromptDir(): string;
export declare function loadPromptBundle(dir?: string): PromptBundle;
export declare function loadModelPromptBundle(dir?: string): PromptBundle;
export declare function promptManifest(dir?: string): {
    prompts: PromptBundle;
    digests: Readonly<Record<"lead" | "worker" | "compact", import("./contracts.js").Digest>>;
};
