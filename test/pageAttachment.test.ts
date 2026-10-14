import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Request, Response } from 'express';

import { attachCarouselToPage, attachCarouselToPageWeb } from '../src/controllers/pageController';
import { attachContentCollectionToPage } from '../src/controllers/contentCollectionController';
import { Carousel } from '../src/models/carousel';
import { ContentCollection } from '../src/models/contentCollection';
import { Page } from '../src/models/page';

const carouselId = '000000000000000000000002';
const actorId = '000000000000000000000001';
const attachedItems = [{ itemId: '000000000000000000000003', itemType: 'carousel' as const, carouselId, order: 0 }];

/** Captures both attachment surfaces without bypassing their controller result handling. */
const responseCapture = () => {
    const captured = { status: 200, body: undefined as any, redirect: '' };
    const response = {
        status(status: number) { captured.status = status; return response; },
        json(body: unknown) { captured.body = body; return response; },
        redirect(location: string) { captured.status = 302; captured.redirect = location; return response; }
    } as unknown as Response;
    return { captured, response };
};

const request = () => ({
    auth: { userId: actorId, role: 'admin' },
    params: { slug: 'home' },
    body: { slug: 'home', carouselId }
}) as unknown as Request;

const next = (error?: unknown) => { throw error ?? new Error('Attachment unexpectedly called next.'); };
const message = (location: string) => new URL(location, 'https://example.test').searchParams.get('message');

for (const [label, surface, presentation, attach] of [
    ['Carousel API', 'API', 'carousel', attachCarouselToPage],
    ['Carousel Web', 'Web', 'carousel', attachCarouselToPageWeb],
    ['Grid API', 'API', 'grid', attachContentCollectionToPage],
    ['List API', 'API', 'list', attachContentCollectionToPage]
] as const) {
    const fixtureRequest = () => {
        const value = request();
        if (presentation !== 'carousel') value.body = { collectionId: carouselId };
        return value;
    };
    const targetModel = presentation === 'carousel' ? Carousel : ContentCollection;
    const mutationMethod = presentation === 'carousel' ? 'addCarouselItem' : 'addCollectionItem';
    const target = { _id: carouselId, presentation };
    const items = presentation === 'carousel' ? attachedItems : [{
        itemId: '000000000000000000000003', itemType: presentation, collectionId: carouselId, order: 0
    }];
    const successMessage = `${presentation === 'carousel' ? 'Carousel' : 'Grid/List'} attached to page.`;

    test(`${label} attachment reports an unapplied transaction instead of success`, async (t) => {
        t.mock.method(Page, 'findBySlug', async () => ({ slug: 'home', items: [] }));
        t.mock.method(targetModel, 'findById', async () => target);
        const mutation = t.mock.method(Page, mutationMethod, async () => null);
        const { captured, response } = responseCapture();

        await attach(fixtureRequest(), response, next);

        assert.equal(mutation.mock.callCount(), 1);
        if (surface === 'API') {
            assert.equal(captured.status, 409);
            assert.equal(captured.body.code, 'page_attachment_not_applied');
            assert.match(captured.body.message, /not attached.*full or no longer available.*Refresh/i);
            assert.equal('items' in captured.body, false);
        } else {
            assert.equal(captured.status, 302);
            assert.match(message(captured.redirect)!, /not attached.*full or no longer available.*Refresh/i);
            assert.equal(new URL(captured.redirect, 'https://example.test').searchParams.get('view'), 'layout');
        }
    });

    test(`${label} attachment preserves the initial missing-Page response without mutation`, async (t) => {
        t.mock.method(Page, 'findBySlug', async () => null);
        const targetLookup = t.mock.method(targetModel, 'findById', async () => target);
        const mutation = t.mock.method(Page, mutationMethod, async () => items);
        const { captured, response } = responseCapture();

        await attach(fixtureRequest(), response, next);

        assert.equal(targetLookup.mock.callCount(), presentation === 'carousel' ? 0 : 1);
        assert.equal(mutation.mock.callCount(), 0);
        if (surface === 'API') {
            assert.equal(captured.status, 404);
            assert.match(captured.body.message, /Page.*not found/);
        } else {
            assert.equal(captured.status, 302);
            assert.match(message(captured.redirect)!, /Page not found/);
        }
    });

    test(`${label} attachment reports success only with committed items`, async (t) => {
        t.mock.method(Page, 'findBySlug', async () => ({ slug: 'home', items: [] }));
        t.mock.method(targetModel, 'findById', async () => target);
        t.mock.method(Page, mutationMethod, async () => items);
        const { captured, response } = responseCapture();

        await attach(fixtureRequest(), response, next);

        if (surface === 'API') {
            assert.equal(captured.status, 200);
            assert.deepEqual(captured.body, { message: successMessage, items });
        } else {
            assert.equal(captured.status, 302);
            assert.equal(message(captured.redirect), successMessage);
        }
    });
}
