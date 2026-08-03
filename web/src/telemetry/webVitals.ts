import type { Metric } from 'web-vitals';
import { onCLS, onINP, onLCP } from 'web-vitals';

import { enqueueListenerTelemetry } from './client';
import { classifyListenerRoute } from './routeClassifier';

const navigationType = (value: Metric['navigationType']) => {
  switch (value) {
    case 'navigate':
    case 'reload':
      return value;
    case 'back-forward':
      return 'back_forward' as const;
    case 'prerender':
      return 'prerender' as const;
    case 'back-forward-cache':
    case 'restore':
      return 'back_forward' as const;
    default:
      return 'unknown' as const;
  }
};

const boundedMetricValue = (metric: Metric) => {
  const maximum = metric.name === 'CLS' ? 5 : 60_000;
  const precision = metric.name === 'CLS' ? 1_000 : 1;
  return Math.round(Math.max(0, Math.min(maximum, metric.value)) * precision) / precision;
};

const reportMetric = (metric: Metric) => {
  if (metric.name !== 'CLS' && metric.name !== 'INP' && metric.name !== 'LCP') return;
  enqueueListenerTelemetry({
    category: 'web_vital',
    metric: metric.name,
    value: boundedMetricValue(metric),
    route: classifyListenerRoute(window.location.pathname),
    navigationType: navigationType(metric.navigationType)
  });
};

/** Registers each standards-based observer once per document load. */
export const startWebVitalsTelemetry = () => {
  onCLS(reportMetric);
  onINP(reportMetric);
  onLCP(reportMetric);
};
