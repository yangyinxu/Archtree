/** Admission flags never relax public visibility enforcement for already hidden content. */
const enabled = (value: string | undefined) => value === 'true';

export const isAdminImportsEnabled = () => enabled(process.env.FINITUDE_ADMIN_IMPORTS_ENABLED);

/**
 * Reports capabilities, never provider secrets or organization/project identifiers.
 * Catalog editing, visibility and local conversion need only the persisted admin role checked by the caller;
 * hidden media stays private because every byte is delivered through visibility-checked server routes.
 */
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
        editing: true as const,
        visibility: true as const
    },
    localMp3Conversion: {
        enabled: true as const,
        readSources: true as const,
        replace: true as const,
        preset: 'mp3-320' as const,
        maxFiles: 100
    }
});
