import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router';

import { queryClient } from './app/queryClient';
import { router } from './app/router';
import { startBrowserSessionCoordinator } from './app/BrowserSessionCoordinator';
import {
  installMessageFormatter,
  LocalizationProvider
} from './localization/LocalizationProvider';
import { installEmbeddedFallback } from './localization/contract';
import fallbackBundleUrl from '../../localization/generated/bundles/en-US.json?url';
import { startListenerTelemetryLifecycle } from './telemetry/client';
import './styles/tokens.css';
import './styles/global.css';

const root = document.getElementById('root');
if (!root) throw new Error('Finitude could not find its application root.');

/** Loads the complete packaged fallback and ICU runtime outside the initial JS graph. */
const startApplication = async () => {
  const [fallbackResponse, formatterModule, validationModule] = await Promise.all([
    fetch(fallbackBundleUrl, { cache: 'force-cache', credentials: 'same-origin' }),
    import('intl-messageformat'),
    import('./localization/bundleValidation')
  ]);
  if (!fallbackResponse.ok) throw new Error('Finitude could not load its packaged language fallback.');
  const fallbackText = await fallbackResponse.text();
  if (new TextEncoder().encode(fallbackText).length > 256 * 1024) {
    throw new Error('The packaged language fallback is too large.');
  }
  installEmbeddedFallback(JSON.parse(fallbackText));
  validationModule.installBundleValidation(formatterModule.default);
  installMessageFormatter(formatterModule.default);
  startBrowserSessionCoordinator(queryClient);

  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <LocalizationProvider>
          <RouterProvider router={router} />
        </LocalizationProvider>
      </QueryClientProvider>
    </StrictMode>
  );

  startListenerTelemetryLifecycle();
  // Core Web Vitals stay in a separate chunk so monitoring cannot consume the listener's entry budget.
  void import('./telemetry/webVitals')
    .then(({ startWebVitalsTelemetry }) => startWebVitalsTelemetry())
    .catch(() => undefined);
};

void startApplication();
