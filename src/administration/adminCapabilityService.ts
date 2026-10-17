/** Admission flags never relax public visibility enforcement for already hidden content. */
const enabled = (value: string | undefined) => value === 'true';

export const isAdminImportsEnabled = () => enabled(process.env.FINITUDE_ADMIN_IMPORTS_ENABLED);
export const isAdminCatalogEditingEnabled = () => enabled(process.env.FINITUDE_ADMIN_CATALOG_ENABLED);
export const isAdminVisibilityEditingEnabled = () => isAdminCatalogEditingEnabled()
    && enabled(process.env.FINITUDE_ADMIN_VISIBILITY_ENABLED)
    && enabled(process.env.FINITUDE_HIDDEN_DELIVERY_ENFORCED);

/** Reports capabilities, never provider secrets or organization/project identifiers. */
export const getAdminCapabilities = () => ({
    schemaVersion: 1 as const,
    admin: true as const,
    albumImports: {
        enabled: isAdminImportsEnabled(),
        analysisAvailable: isAdminImportsEnabled() && Boolean(process.env.OPENAI_API_KEY?.trim()),
        model: 'gpt-6-luna' as const,
        maxFiles: 100
    },
    catalog: {
        editing: isAdminCatalogEditingEnabled(),
        visibility: isAdminVisibilityEditingEnabled()
    },
    localMp3Conversion: {
        enabled: isAdminCatalogEditingEnabled(),
        readSources: isAdminCatalogEditingEnabled(),
        replace: isAdminCatalogEditingEnabled(),
        preset: 'mp3-320' as const,
        maxFiles: 100
    }
});
