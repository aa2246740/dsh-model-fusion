import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import type { Digest, Role, TaskId } from '../contracts.js';
export interface AuxiliaryRequest {
    purpose: 'cache-keepalive';
    taskId: TaskId;
    sessionId: string;
    profileDigest: Digest;
    role: Role;
    seriesId: string;
    iteration: number;
}
/** Plugin-local identity: do not widen or misuse the Host's purpose enum. */
export declare class NativeAuxiliaryRequests {
    #private;
    tag(request: GenerateOptions, metadata: AuxiliaryRequest): void;
    get(request: GenerateOptions): Readonly<AuxiliaryRequest> | undefined;
}
