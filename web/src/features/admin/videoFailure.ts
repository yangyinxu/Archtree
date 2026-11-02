/** Only fixed classifications become UI copy; raw processor diagnostics never reach the page. */
export function videoProcessingIssue(issue: string | null) {
  switch (issue) {
    case 'invalid_source': case 'unsupported_layout': return 'invalid';
    case 'processor_unavailable': return 'unavailable';
    case 'processor_busy': return 'busy';
    case 'processing_timeout': return 'timeout';
    default: return 'retry';
  }
}

/** These failures retire the old approval and require a current snapshot, without re-uploading media. */
export const videoPublicationNeedsReview = (issue: string | null) => issue === 'reference_changed' || issue === 'approval_expired';
