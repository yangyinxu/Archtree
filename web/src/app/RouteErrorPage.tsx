import { isRouteErrorResponse, Link, useRouteError } from 'react-router';

import styles from '../styles/Pages.module.css';

/** Bounds route failures without exposing internal exception details. */
export const RouteErrorPage = () => {
  const error = useRouteError();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  return (
    <div className={styles.page}>
      <section className={styles.panel}>
        <div>
          <p className={styles.eyebrow}>{notFound ? '404' : 'Listening continues'}</p>
          <h1 className={styles.panelTitle}>{notFound ? 'That page drifted out of range' : 'Finitude hit an unexpected note'}</h1>
          <p className={styles.panelCopy}>Return Home and keep exploring from there.</p>
          <div className={styles.actions}><Link className={styles.primaryLink} to="/">Go Home</Link></div>
        </div>
      </section>
    </div>
  );
};

export const NotFoundPage = () => (
  <div className={styles.page}>
    <section className={styles.panel}>
      <div>
        <p className={styles.eyebrow}>404</p>
        <h1 className={styles.panelTitle}>That page drifted out of range</h1>
        <p className={styles.panelCopy}>The address may have changed, but the listening room is still here.</p>
        <div className={styles.actions}><Link className={styles.primaryLink} to="/">Go Home</Link></div>
      </div>
    </section>
  </div>
);
