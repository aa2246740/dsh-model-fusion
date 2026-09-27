/** Visible-session polling reads the plugin ledger; it never sends a chat message. */
export declare function FusionStatus({ sessionId, attentionOnly }: {
    sessionId: string;
    attentionOnly?: boolean;
}): import("react").JSX.Element | null;
