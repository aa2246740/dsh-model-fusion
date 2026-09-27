import type { PhysicalRoute } from '../contracts.js';
import type { SettingsCatalog } from '../host/settings.js';
export declare function ModelChoice({ role, route, catalog, onChange }: {
    role: 'Lead' | 'Sidekick' | 'compactor';
    route?: PhysicalRoute;
    catalog: SettingsCatalog;
    onChange(route: PhysicalRoute | undefined): void;
}): import("react").JSX.Element;
export declare function FusionSettings(): import("react").JSX.Element;
