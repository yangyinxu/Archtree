import { useEffect, useRef, useState } from 'react';
import { adminWorkspace, useAdminWorkspace } from './adminWorkspace';

/** Loads near-visible covers without retaining bytes after a private view or source changes. */
export function useCatalogArtwork(path: string | null, viewerId: string, eager: boolean) {
  const workspace = useAdminWorkspace();
  const element = useRef<HTMLSpanElement>(null);
  const key = `${path}:${viewerId}:${workspace.epoch}:${workspace.generation}:${workspace.authority}`;
  const [image, setImage] = useState({ key: '', url: '' });
  const allowed = workspace.authorized && workspace.mode === 'admin' && workspace.viewerId === viewerId
    && adminWorkspace.current(workspace);

  useEffect(() => {
    // A layout transition can invalidate the rendered view before passive effects start.
    if (!path || !allowed || !adminWorkspace.current(workspace)) return;
    const guard = adminWorkspace.capture();
    const controller = new AbortController();
    let url = '', started = false;
    const unsubscribe = adminWorkspace.subscribe(() => {
      if (!adminWorkspace.current(guard)) {
        controller.abort();
        if (url) URL.revokeObjectURL(url);
        url = '';
      }
    });
    const start = () => {
      if (started || controller.signal.aborted) return;
      started = true;
      void import('./catalogArtworkLoader').then(({ loadCatalogArtwork }) => loadCatalogArtwork(path, guard, controller.signal)).then(blob => {
        if (controller.signal.aborted || !adminWorkspace.current(guard)) return;
        url = URL.createObjectURL(blob);
        setImage({ key, url });
      }).catch(() => { /* Missing or refused artwork keeps the normal placeholder. */ });
    };
    const observer = !eager && typeof IntersectionObserver !== 'undefined' && element.current
      ? new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) { observer?.disconnect(); start(); }
      }, { rootMargin: '300px' }) : null;
    if (observer) observer.observe(element.current!); else start();
    return () => {
      observer?.disconnect(); unsubscribe(); controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [allowed, eager, key, path]);

  return { ref: element, src: allowed && image.key === key ? image.url : null };
}
