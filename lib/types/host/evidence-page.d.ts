/** Lossless text decoding; binary artifacts stay available as explicit base64. */
export declare function evidenceText(bytes: Uint8Array): string | undefined;
/** Offsets count UTF-16 code units of text, or characters of base64. */
export declare function evidencePage(bytes: Uint8Array, offset?: number, limit?: number): {
    bytes: number;
    encoding: string;
    offsetUnit: string;
    offset: number;
    totalCharacters: number;
    text: string;
    truncated: boolean;
    nextOffset: number | null;
};
