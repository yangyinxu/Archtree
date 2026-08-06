import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assertStaticAssetBudget,
  measureStaticAssets
} from './check-static-asset-budget.mjs';

describe('listener static-asset budget', () => {
  const temporaryRoots = [];

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('measures nested CSS, font, and image output', () => {
    const root = mkdtempSync(join(tmpdir(), 'finitude-asset-budget-'));
    temporaryRoots.push(root);
    const nested = join(root, 'assets');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'listener.css'), '.panel { color: white; }');
    writeFileSync(join(nested, 'listener.woff2'), Buffer.alloc(12));
    writeFileSync(join(nested, 'cover.webp'), Buffer.alloc(24));

    const result = measureStaticAssets(root);

    expect(result.cssGzipBytes).toBeGreaterThan(0);
    expect(result.fontBytes).toBe(12);
    expect(result.imageBytes).toBe(24);
    expect(result.largestImage).toEqual({ file: 'cover.webp', bytes: 24 });
  });

  it('reports every exceeded category', () => {
    expect(() => assertStaticAssetBudget({
      cssGzipBytes: 11,
      fontBytes: 12,
      imageBytes: 13,
      largestImage: { file: 'oversized.webp', bytes: 14 }
    }, {
      cssGzipBytes: 1,
      fontBytes: 2,
      imageBytes: 3,
      individualImageBytes: 4
    })).toThrow(/CSS.*fonts.*bundled images.*oversized\.webp/);
  });
});
