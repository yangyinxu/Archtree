import { describe, expect, test } from 'vitest';

import './tokens.css';

/** Guards the semantic visual contract that route styles consume. */
describe('listener visual tokens', () => {
  test('exposes the approved surface, spacing, type, motion, and layer roles', () => {
    const tokens = getComputedStyle(document.documentElement);
    const expected = [
      '--color-canvas',
      '--color-surface',
      '--color-surface-raised',
      '--color-surface-hover',
      '--color-text',
      '--color-text-muted',
      '--color-text-subtle',
      '--color-accent',
      '--color-danger',
      '--color-focus',
      '--type-caption',
      '--type-metadata',
      '--type-body',
      '--type-control-label',
      '--type-card-title',
      '--type-section-title',
      '--type-page-title',
      '--type-display',
      '--motion-fast',
      '--motion-medium',
      '--layer-player',
      '--layer-topbar',
      '--layer-menu',
      '--layer-modal',
      '--layer-expanded-player',
      '--layer-help'
    ];

    for (const token of expected) {
      expect(tokens.getPropertyValue(token).trim(), token).not.toBe('');
    }

    expect(Array.from({ length: 8 }, (_, index) => (
      tokens.getPropertyValue(`--space-${index + 1}`).trim()
    ))).toEqual(['0.25rem', '0.5rem', '0.75rem', '1rem', '1.5rem', '2rem', '2.5rem', '3rem']);
  });
});
