import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

import { expect, test } from './test';

const releaseBlockingImpacts = new Set(['critical', 'serious']);
const ownedModerateRuleIds = new Set<string>();

/** Fails release blockers and any moderate finding without an explicit owner. */
export const expectNoUnownedAxeViolations = async (page: Page, label: string) => {
  const results = await new AxeBuilder({ page }).analyze();
  await test.info().attach(`axe-${label}`, {
    body: JSON.stringify(results, null, 2),
    contentType: 'application/json'
  });
  const violations = results.violations.filter((violation) => {
    const impact = violation.impact;
    return typeof impact === 'string' && (
      releaseBlockingImpacts.has(impact)
      || (impact === 'moderate'
        && (violation.id === undefined || !ownedModerateRuleIds.has(violation.id)))
    );
  });

  expect(
    violations,
    `${label} has unowned axe findings:\n${JSON.stringify(violations, null, 2)}`
  ).toEqual([]);
};
