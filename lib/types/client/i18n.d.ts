/** The DSH client locale service (`ctx.locale`), used by structure only. */
interface LocaleSource {
    getSnapshot(): {
        active: string;
    };
    subscribe(listener: () => void): () => void;
}
/** Called from the client entry when DSH's locale service is available; follows the user's language setting. */
export declare function bindLocale(next: LocaleSource): () => void;
export type Lang = 'zh' | 'en';
/** The UI language: Chinese for any zh locale, English otherwise (DSH's own fallback). */
export declare function useLang(): Lang;
/** Pick the text for the active language. */
export declare const tr: (lang: Lang, zh: string, en: string) => string;
export {};
