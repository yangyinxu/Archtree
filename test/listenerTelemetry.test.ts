import assert from 'node:assert/strict';
import test from 'node:test';

import {
    ListenerTelemetryValidationError,
    parseListenerTelemetryBatch,
    recordListenerTelemetryBatch,
    type RecordedListenerTelemetryEvent
} from '../src/services/listenerTelemetryService';

const validEvents = [
    {
        category: 'web_vital',
        route: 'home',
        metric: 'LCP',
        value: 2450.6,
        navigationType: 'navigate'
    },
    {
        category: 'route_error',
        route: 'album',
        kind: 'lazy_chunk',
        statusBucket: 'none'
    },
    {
        category: 'api_error',
        route: 'library',
        operation: 'listener_library',
        kind: 'http',
        statusBucket: '5xx',
        attempt: 'after_refresh',
        latencyBucket: '1_to_3s'
    },
    {
        category: 'playback_error',
        route: 'artist',
        stage: 'media_element',
        code: 'decode'
    }
] as const;

test('records every bounded event with only server-owned metadata', () => {
    const recorded: RecordedListenerTelemetryEvent[] = [];
    const count = recordListenerTelemetryBatch(
        { events: validEvents },
        (event) => recorded.push(event),
        () => new Date('2026-08-03T12:00:00.000Z')
    );

    assert.equal(count, 4);
    assert.equal(recorded.length, 4);
    assert.deepEqual(recorded[0], {
        schemaVersion: 1,
        occurredAt: '2026-08-03T12:00:00.000Z',
        category: 'web_vital',
        route: 'home',
        metric: 'LCP',
        value: 2451,
        navigationType: 'navigate'
    });
    assert.deepEqual(recorded[3], {
        schemaVersion: 1,
        occurredAt: '2026-08-03T12:00:00.000Z',
        category: 'playback_error',
        route: 'artist',
        stage: 'media_element',
        code: 'decode'
    });
});

test('normalizes bounded Web Vital precision and permits optional fields to be absent', () => {
    const events = parseListenerTelemetryBatch({ events: [
        { category: 'web_vital', route: 'search', metric: 'CLS', value: 0.12356 },
        {
            category: 'api_error',
            route: 'home',
            operation: 'listener_home',
            kind: 'network',
            statusBucket: 'none',
            attempt: 'initial'
        }
    ] });

    assert.deepEqual(events, [
        { category: 'web_vital', route: 'search', metric: 'CLS', value: 0.124 },
        {
            category: 'api_error',
            route: 'home',
            operation: 'listener_home',
            kind: 'network',
            statusBucket: 'none',
            attempt: 'initial'
        }
    ]);
});

test('rejects empty, oversized, or non-strict envelopes', () => {
    for (const payload of [
        null,
        {},
        { events: [] },
        { events: Array.from({ length: 11 }, () => validEvents[0]) },
        { events: [validEvents[0]], timestamp: '2026-08-03T12:00:00.000Z' }
    ]) {
        assert.throws(
            () => parseListenerTelemetryBatch(payload),
            ListenerTelemetryValidationError
        );
    }
});

test('rejects unknown event fields and every identity or raw diagnostic field', () => {
    const forbiddenFields = {
        email: 'listener@example.com',
        userId: 'account-id',
        sessionId: 'session-id',
        url: '/listen/search?q=private-query',
        query: 'private-query',
        contentId: 'track-id',
        contentTitle: 'private title',
        searchTerm: 'private search',
        ipAddress: '198.51.100.1',
        deviceFingerprint: 'private fingerprint',
        visitorId: 'persistent visitor',
        error: 'raw exception text',
        stack: 'raw stack'
    };

    for (const [key, value] of Object.entries(forbiddenFields)) {
        assert.throws(
            () => parseListenerTelemetryBatch({
                events: [{ ...validEvents[3], [key]: value }]
            }),
            ListenerTelemetryValidationError
        );
    }
});

test('rejects authentication funnel events and unlisted API operations', () => {
    for (const event of [
        {
            category: 'authentication_funnel',
            route: 'auth',
            stage: 'login',
            method: 'password',
            outcome: 'rejected'
        },
        {
            category: 'api_error',
            route: 'auth',
            operation: 'auth_login',
            kind: 'http',
            statusBucket: '401',
            attempt: 'initial'
        }
    ]) {
        assert.throws(
            () => parseListenerTelemetryBatch({ events: [event] }),
            ListenerTelemetryValidationError
        );
    }
});

test('rejects invalid enums, non-finite vitals, and inconsistent API status classes', () => {
    const invalidEvents = [
        { ...validEvents[0], route: '/albums/private-id' },
        { ...validEvents[0], metric: 'FID' },
        { ...validEvents[0], value: Number.NaN },
        { ...validEvents[0], value: 60_001 },
        { category: 'web_vital', route: 'home', metric: 'CLS', value: 5.001 },
        { ...validEvents[1], statusBucket: '503' },
        {
            category: 'api_error',
            route: 'home',
            operation: 'listener_home',
            kind: 'http',
            statusBucket: 'none',
            attempt: 'initial'
        },
        {
            category: 'api_error',
            route: 'home',
            operation: 'listener_home',
            kind: 'network',
            statusBucket: '5xx',
            attempt: 'initial'
        }
    ];

    for (const event of invalidEvents) {
        assert.throws(
            () => parseListenerTelemetryBatch({ events: [event] }),
            ListenerTelemetryValidationError
        );
    }
});

test('validates the complete batch before emitting any event', () => {
    const recorded: RecordedListenerTelemetryEvent[] = [];

    assert.throws(
        () => recordListenerTelemetryBatch(
            { events: [validEvents[0], { ...validEvents[1], url: '/private' }] },
            (event) => recorded.push(event)
        ),
        ListenerTelemetryValidationError
    );
    assert.deepEqual(recorded, []);
});
