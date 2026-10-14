import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { PhysicalRoute, Role } from '../contracts.js';
import type { SessionBinding } from './bindings.js';
interface Owner {
    binding: SessionBinding;
    role: Role;
}
/** Publish exact session routes before another plugin estimates or chunks input. */
export declare function installCompactionRouting(ctx: Context, input: {
    owner(agent: Agent): Owner | undefined;
    route(binding: SessionBinding, role: Role): PhysicalRoute;
    epoch(binding: SessionBinding): number;
}): () => void;
export {};
