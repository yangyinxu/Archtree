import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { ListenerCatalogCredit } from '../../../src/contracts/listenerV1';

/** The Credit fields a byline needs to link a name to its Artist or Organization page. */
export interface BylineCredit {
  subjectType: 'artist' | 'organization';
  subjectId: string;
  name: string;
  order: number;
  role: ListenerCatalogCredit['role'];
}

/**
 * Renders a server-built byline verbatim and links each credited name found, in Credit order.
 * Join phrases stay server-owned: the rendered text is always identical to `text`, and names the
 * byline does not contain (such as a label) are skipped.
 */
export const LinkedByline = ({ text, credits }: { text: string; credits?: readonly BylineCredit[] }) => {
  const parts: ReactNode[] = [];
  let cursor = 0;
  // Match catalogBylineSegments: an omitted Credit must never claim a shown name's prefix.
  const sorted = [...credits ?? []].sort((left, right) => left.order - right.order).filter(credit => credit.name !== '');
  const performing = sorted.filter(credit => ['primary', 'featured', 'performer'].includes(credit.role));
  const organizations = sorted.filter(credit => credit.subjectType === 'organization');
  const shown = performing.length ? performing : organizations.length ? organizations : sorted;
  const seen = new Set<string>();
  for (const credit of shown) {
    if (seen.has(credit.name)) continue;
    seen.add(credit.name);
    const at = text.indexOf(credit.name, cursor);
    if (at < 0) continue;
    parts.push(text.slice(cursor, at), <Link
      key={parts.length}
      to={`/${credit.subjectType === 'artist' ? 'artists' : 'organizations'}/${encodeURIComponent(credit.subjectId)}`}
    >{credit.name}</Link>);
    cursor = at + credit.name.length;
  }
  return <>{parts}{text.slice(cursor)}</>;
};
