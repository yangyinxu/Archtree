const enabledUnlessFalse = (name: string) => String(process.env[name] ?? 'true').toLowerCase() !== 'false';
const enabledOnlyWhenTrue = (name: string) => String(process.env[name] ?? 'false').toLowerCase() === 'true';

/** Centralizes independently reversible Catalog Credit rollout switches. */
export const catalogCreditRollout = () => ({
    readsEnabled: enabledUnlessFalse('CATALOG_CREDIT_READS_ENABLED'),
    writesEnabled: enabledUnlessFalse('CATALOG_CREDIT_WRITES_ENABLED'),
    sectionsEnabled: enabledUnlessFalse('CATALOG_CREDIT_SECTIONS_ENABLED'),
    organizationSurfacesEnabled: enabledUnlessFalse('CATALOG_ORGANIZATION_SURFACES_ENABLED'),
    rejectLegacyWrites: enabledOnlyWhenTrue('CATALOG_CREDIT_REJECT_LEGACY_WRITES')
});

export class CatalogCreditWritesDisabledError extends Error {
    readonly statusCode = 503;
    readonly code = 'catalog_credit_writes_disabled';

    constructor() {
        super('Catalog Credit changes are temporarily disabled. Please try again later.');
    }
}

export const requireCatalogCreditWrites = () => {
    if (!catalogCreditRollout().writesEnabled) throw new CatalogCreditWritesDisabledError();
};
