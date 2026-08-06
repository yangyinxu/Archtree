import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router';

import { queryClient } from './app/queryClient';
import { router } from './app/router';
import { startBrowserSessionCoordinator } from './app/BrowserSessionCoordinator';
import { startListenerTelemetryLifecycle } from './telemetry/client';
import './styles/tokens.css';
import './styles/global.css';

const root = document.getElementById('root');
if (!root) throw new Error('Finitude could not find its application root.');
startBrowserSessionCoordinator(queryClient);

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>
);

startListenerTelemetryLifecycle();
// Core Web Vitals stay in a separate chunk so monitoring cannot consume the listener's entry budget.
void import('./telemetry/webVitals')
  .then(({ startWebVitalsTelemetry }) => startWebVitalsTelemetry())
  .catch(() => undefined);
