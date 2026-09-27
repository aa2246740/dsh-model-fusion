import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client';
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store';
export interface FusionHintProps {
    sessionId: string;
    directory: ObservableSnapshot<ModelDirectoryState>;
    load(): void;
}
/** Additive composer hint. The original selector and its selection state stay native. */
export declare function FusionHint({ sessionId, directory, load }: FusionHintProps): import("react").JSX.Element | null;
