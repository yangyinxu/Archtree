import { useEffect } from 'react';
import { isRouteErrorResponse, Link, useLocation, useRouteError } from 'react-router';

import { enqueueListenerTelemetry } from '../telemetry/client';
import { classifyListenerRoute, statusBucket } from '../telemetry/routeClassifier';
import styles from '../styles/Pages.module.css';
import { useLocalization } from '../localization/LocalizationProvider';

/** Bounds route failures without exposing internal exception details. */
export const RouteErrorPage = () => {
  const error = useRouteError();
  const location = useLocation();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  const { t } = useLocalization();
  useEffect(() => {
    const lazyChunk = error instanceof Error && (
      error.name === 'ChunkLoadError' || /dynamically imported module|loading chunk/i.test(error.message)
    );
    enqueueListenerTelemetry({
      category: 'route_error',
      route: notFound ? 'not_found' : classifyListenerRoute(location.pathname),
      kind: isRouteErrorResponse(error) ? 'route_response' : lazyChunk ? 'lazy_chunk' : 'render',
      statusBucket: statusBucket(isRouteErrorResponse(error) ? error.status : 500)
    });
  }, [error, location.pathname, notFound]);
  return (
    <div className={styles.page}>
      <section className={styles.panel}>
        <div>
          <p className={styles.eyebrow}>{notFound ? '404' : t('route.error.eyebrow')}</p>
          <h1 className={styles.panelTitle}>
            {notFound ? t('route.not_found.title') : t('route.error.title')}
          </h1>
          <p className={styles.panelCopy}>{t('route.error.copy')}</p>
          <div className={styles.actions}>
            <Link className={styles.primaryLink} to="/">{t('common.action.go_home')}</Link>
          </div>
        </div>
      </section>
    </div>
  );
};

export const NotFoundPage = () => {
  const { t } = useLocalization();
  useEffect(() => {
    enqueueListenerTelemetry({
      category: 'route_error',
      route: 'not_found',
      kind: 'route_response',
      statusBucket: '404'
    });
  }, []);
  return (
    <div className={styles.page}>
      <section className={styles.panel}>
        <div>
          <p className={styles.eyebrow}>404</p>
          <h1 className={styles.panelTitle}>{t('route.not_found.title')}</h1>
          <p className={styles.panelCopy}>{t('route.not_found.copy')}</p>
          <div className={styles.actions}>
            <Link className={styles.primaryLink} to="/">{t('common.action.go_home')}</Link>
          </div>
        </div>
      </section>
    </div>
  );
};
