import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const browserSessionFormsClient = readFileSync(
    new URL('../src/public/browser-session-forms.js', import.meta.url),
    'utf8'
);

test('Archtree login uses the coordinated browser-session contract', () => {
    assert.match(browserSessionFormsClient, /finitude:browser-session-transition/);
    assert.match(browserSessionFormsClient, /locks\.request\(sessionTransitionLockName/);
    assert.match(browserSessionFormsClient, /fetch\('\/auth\/browser\/login'/);
    assert.match(browserSessionFormsClient, /'X-Finitude-Session-Transition': 'web-locks-v1'/);
    assert.match(browserSessionFormsClient, /publishSessionChange\('login'\)/);
});

test('Archtree login stays signed out when the shared Web Lock is unavailable', () => {
    assert.match(browserSessionFormsClient, /if \(!locks\)/);
    assert.match(browserSessionFormsClient, /cannot safely coordinate login across tabs/);
});

test('Archtree logout clears the current browser session without a Finitude redirect', () => {
    assert.match(browserSessionFormsClient, /fetch\('\/auth\/browser\/logout'/);
    assert.match(browserSessionFormsClient, /'X-Finitude-Account-Viewer': viewerId/);
    assert.match(browserSessionFormsClient, /completeLogout\(viewerId\)/);
    assert.match(browserSessionFormsClient, /publishSessionChange\('logout'\)/);
    assert.match(browserSessionFormsClient, /window\.location\.assign\('\/'\)/);
    assert.doesNotMatch(browserSessionFormsClient, /location\.assign\('\/finitude/);
});
