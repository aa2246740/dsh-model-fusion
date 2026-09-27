import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client';
export declare const fusionControlTools: readonly ["fusion_read_state", "fusion_delegate_text", "fusion_explore", "fusion_delegate", "fusion_rework", "fusion_wait", "fusion_review_result", "fusion_submit_result", "fusion_takeover", "fusion_finish_direct", "fusion_read_evidence"];
/** Keep internal coordination out of the normal conversation. Errors remain visible. */
export declare function FusionTool({ block, sessionId, callId, toolName, cwd, openFile }: ToolCallViewProps): import("react").JSX.Element;
