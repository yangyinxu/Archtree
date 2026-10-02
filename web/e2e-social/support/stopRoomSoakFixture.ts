import type { FullConfig } from '@playwright/test';

/** Runs even after a failed browser test; the capability is ephemeral and never part of evidence. */
export default async function stopRoomSoakFixture(config: FullConfig) {
  const token = config.webServer?.env?.FINITUDE_ROOM_SOAK_STOP_TOKEN;
  if (typeof token !== 'string') throw new Error('Disposable shutdown capability is missing.');
  const response = await fetch('http://127.0.0.1:4188/stop', {
    method: 'POST', headers: { 'x-fixture-stop-token': token }, signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok || (await response.json()).cleanupComplete !== true) {
    throw new Error('Owned room soak fixture cleanup failed.');
  }
}
