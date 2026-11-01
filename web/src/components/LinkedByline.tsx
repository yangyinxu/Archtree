import type { ReactNode } from 'react';
import { Link } from 'react-router';

/** The Credit fields a byline needs to link a name to its Artist or Organization page. */
export interface BylineCredit {
  subjectType: 'artist' | 'organization';
  subjectId: string;
  name: string;
  order: number;
}

/**
 * Renders a server-built byline verbatim and links each credited name found, in Credit order.
 * Join phrases stay server-owned: the rendered text is always identical to `text`, and names the
 * byline does not contain (such as a label) are skipped.
 */
export const LinkedByline = ({ text, credits }: { text: string; credits?: readonly BylineCredit[] }) => {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const credit of [...credits ?? []].sort((left, right) => left.order - right.order)) {
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
