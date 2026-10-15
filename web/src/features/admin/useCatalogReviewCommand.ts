import { useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AdminCommand, clearCatalogProjections } from './useAdminCommand';
import { adminWorkspace } from './adminWorkspace';
import { reviewMutationSchema, type ReviewMutation } from './catalogReviewApi';

/** Private review writes preserve listener projections; only confirmed catalog application invalidates them. */
export function useCatalogReviewCommand(key: string, target: { id?: string; albumId?: string } = {}) {
  const client = useQueryClient();
  const [command] = useState(() => {
    const buffer = `catalog-review-command:${key}`;
    const previous = adminWorkspace.buffer<AdminCommand<ReviewMutation>>(buffer);
    if (previous) return previous;
    const schema = reviewMutationSchema.refine(value => (!target.id || value.item.id === target.id)
      && (!target.albumId || value.item.source.album.id === target.albumId), 'Mismatched catalog review');
    const value = new AdminCommand(schema, () => {
      if (value.getSnapshot().intent?.path.endsWith('/apply')) clearCatalogProjections(client);
    });
    adminWorkspace.retain(buffer, value, adminWorkspace.capture());
    return value;
  });
  return { command, ...useSyncExternalStore(command.subscribe, command.getSnapshot, command.getSnapshot) };
}
