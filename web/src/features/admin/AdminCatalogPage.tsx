import { lazy, Suspense } from 'react';
import { AdminGate, useAdminText } from './AdminAccess';
import type { CatalogKind } from './catalogApi';

const CatalogInventory = lazy(() => import('./AdminCatalogInventory').then(module => ({ default: module.AdminCatalogInventory })));
const CatalogEditor = lazy(() => import('./AdminCatalogEditor').then(module => ({ default: module.AdminCatalogEditor })));

/** Loads only browsing or editing after the current administrator view has been admitted. */
export function AdminCatalogPage({ kind, id }: { kind?: CatalogKind; id?: string }) {
  const t = useAdminText();
  return <AdminGate><Suspense fallback={<p role="status">{t('common.loading')}</p>}>{kind && id
    ? <CatalogEditor key={`${kind}:${id}`} kind={kind} id={id} /> : <CatalogInventory />}</Suspense></AdminGate>;
}
