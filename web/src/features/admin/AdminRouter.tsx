import { lazy, Suspense } from 'react';
import { useLocation } from 'react-router';
import type { CatalogKind } from './catalogApi';
import { useAdminText } from './AdminAccess';
const AdminWorkbenchPage = lazy(() => import('./AdminWorkbenchPage').then(module => ({ default: module.AdminWorkbenchPage })));
const AdminCreateImportPage = lazy(() => import('./AdminCreateImportPage').then(module => ({ default: module.AdminCreateImportPage })));
const AdminCatalogPage = lazy(() => import('./AdminCatalogPage').then(module => ({ default: module.AdminCatalogPage })));
const AdminPagesPage = lazy(() => import('./AdminPagesPage').then(module => ({ default: module.AdminPagesPage })));
const AdminImportPage = lazy(() => import('./AdminImportPage').then(module => ({ default: module.AdminImportPage })));

/** The lazy route family keeps administrator code outside the ordinary listener route graph. */
function AdminRoute() {
  const { pathname } = useLocation();
  if (pathname === '/admin/catalog') return <AdminCatalogPage />;
  if (pathname === '/admin/pages') return <AdminPagesPage />;
  const catalog = /^\/admin\/catalog\/(album|artist|audioTrack|organization)\/([a-f0-9]{24})$/.exec(pathname);
  if (catalog) return <AdminCatalogPage kind={catalog[1] as CatalogKind} id={catalog[2]} />;
  if (pathname === '/admin/imports/new') return <AdminCreateImportPage />;
  const match = /^\/admin\/imports\/([a-f0-9]{24})$/.exec(pathname);
  if (match) return <AdminImportPage projectId={match[1]} />;
  return <AdminWorkbenchPage />;
}
export default function AdminRouter() {
  const t = useAdminText();
  return <Suspense fallback={<p role="status">{t('common.loading')}</p>}><AdminRoute /></Suspense>;
}
