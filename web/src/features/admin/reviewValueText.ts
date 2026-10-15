/** Partial dates retain their precision without exposing their transport representation. */
export const reviewValueText = (value: unknown): string => {
  if (value == null || value === '') return '—';
  if (typeof value !== 'object') return String(value);
  if ('year' in value && typeof value.year === 'number') {
    const date = value as { year: number; month: number | null; day: number | null };
    return String(date.year).padStart(4, '0') + (date.month == null ? '' : `-${String(date.month).padStart(2, '0')}`)
      + (date.day == null ? '' : `-${String(date.day).padStart(2, '0')}`);
  }
  return JSON.stringify(value);
};
