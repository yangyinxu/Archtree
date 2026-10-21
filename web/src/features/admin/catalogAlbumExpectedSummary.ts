/**
 * What an Album's expected tracklist clear removes, as the Tracks section last read it. Kept apart from the strict Tracks schema
 * so the lazy catalog confirmation can name it without loading that schema.
 */
export type CatalogAlbumExpectedSummary = { source: 'musicbrainz' | 'itunes'; appliedAt: string; rows: number; noFile: number };

type ExpectedRows = { source: CatalogAlbumExpectedSummary['source']; appliedAt: string; rows: ReadonlyArray<{ memberIds: readonly string[] }> };

/** Counts the rows and those without a file, which no member fills. */
export const expectedSummary = (expected: ExpectedRows): CatalogAlbumExpectedSummary => ({
  source: expected.source, appliedAt: expected.appliedAt, rows: expected.rows.length,
  noFile: expected.rows.filter(row => !row.memberIds.length).length
});
/** Message variables for a summary; the source names are proper names and stay untranslated, and the date is the viewer's. */
export const expectedSummaryVariables = (summary: CatalogAlbumExpectedSummary, locale: string) => ({
  source: summary.source === 'musicbrainz' ? 'MusicBrainz' : 'iTunes',
  date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(summary.appliedAt)),
  rows: summary.rows, noFile: summary.noFile
});
