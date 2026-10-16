import type { Collection } from 'mongodb';

import { getDb } from '../infrastructure/database';
import {
    portfolioProjects,
    type PortfolioProject,
    type PortfolioVisibility
} from './projectCatalog';

/** One stored position; the array order is the display order. */
export interface StoredPortfolioEntry {
    slug: string;
    visibility: PortfolioVisibility;
}

/** The single settings document. `revision` starts at 1 on first write. */
export interface StoredPortfolio {
    revision: number;
    projects: StoredPortfolioEntry[];
}

export interface PortfolioEntry {
    project: PortfolioProject;
    visibility: PortfolioVisibility;
}

export interface ResolvedPortfolio {
    /** 0 when nothing has been stored yet. */
    revision: number;
    entries: PortfolioEntry[];
}

export type PortfolioChange =
    | { kind: 'move'; slug: string; direction: 'up' | 'down' }
    | { kind: 'visibility'; slug: string; visibility: PortfolioVisibility };

export type PortfolioChangeOutcome = 'applied' | 'noop' | 'stale' | 'unknown_project';

/** Persistence seam so routes and the homepage can be tested without MongoDB. */
export interface PortfolioStore {
    read(): Promise<StoredPortfolio | null>;
    /** Writes only when the stored revision still equals `expectedRevision`. */
    write(expectedRevision: number, projects: StoredPortfolioEntry[], actorId: string): Promise<boolean>;
}

/**
 * Merges the stored order with the code catalog: unknown or repeated slugs are
 * dropped, and catalog projects missing from storage follow in catalog order
 * with their default visibility.
 */
export const resolvePortfolio = (
    stored: StoredPortfolio | null,
    catalog: readonly PortfolioProject[] = portfolioProjects
): ResolvedPortfolio => {
    const bySlug = new Map(catalog.map((project) => [project.slug, project]));
    const entries: PortfolioEntry[] = [];
    const seen = new Set<string>();
    for (const item of stored?.projects ?? []) {
        const project = bySlug.get(item.slug);
        if (!project || seen.has(item.slug)) continue;
        seen.add(item.slug);
        entries.push({ project, visibility: item.visibility === 'hidden' ? 'hidden' : 'public' });
    }
    for (const project of catalog) {
        if (!seen.has(project.slug)) entries.push({ project, visibility: project.defaultVisibility });
    }
    return { revision: stored?.revision ?? 0, entries };
};

/** Returns the reordered or re-flagged entries, or null when the change has no effect. */
export const applyPortfolioChange = (
    entries: readonly PortfolioEntry[],
    change: PortfolioChange
): PortfolioEntry[] | null => {
    const index = entries.findIndex((entry) => entry.project.slug === change.slug);
    if (index < 0) return null;
    if (change.kind === 'visibility') {
        if (entries[index].visibility === change.visibility) return null;
        return entries.map((entry, position) => position === index
            ? { ...entry, visibility: change.visibility }
            : entry);
    }
    const target = change.direction === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= entries.length) return null;
    const next = [...entries];
    [next[index], next[target]] = [next[target], next[index]];
    return next;
};

/** Applies one administrator change against the revision the administrator last saw. */
export const changePortfolio = async (
    store: PortfolioStore,
    expectedRevision: number,
    change: PortfolioChange,
    actorId: string,
    catalog: readonly PortfolioProject[] = portfolioProjects
): Promise<PortfolioChangeOutcome> => {
    if (!catalog.some((project) => project.slug === change.slug)) return 'unknown_project';
    const current = resolvePortfolio(await store.read(), catalog);
    if (current.revision !== expectedRevision) return 'stale';
    const next = applyPortfolioChange(current.entries, change);
    if (!next) return 'noop';
    const written = await store.write(
        expectedRevision,
        next.map((entry) => ({ slug: entry.project.slug, visibility: entry.visibility })),
        actorId
    );
    return written ? 'applied' : 'stale';
};

/** Public entries in display order; a store failure falls back to catalog defaults. */
export const listPublicPortfolioProjects = async (
    store: PortfolioStore,
    onReadError: (error: unknown) => void = () => undefined
): Promise<PortfolioProject[]> => {
    let stored: StoredPortfolio | null = null;
    try {
        stored = await store.read();
    } catch (error) {
        onReadError(error);
    }
    return resolvePortfolio(stored).entries
        .filter((entry) => entry.visibility === 'public')
        .map((entry) => entry.project);
};

interface PortfolioDocument extends StoredPortfolio {
    _id: 'projects';
    updatedAt: Date;
    updatedBy: string;
}

const portfolioCollection = (): Collection<PortfolioDocument> => {
    const db = getDb();
    if (!db) throw new Error('Database is not connected.');
    return db.collection<PortfolioDocument>('portfolioSettings');
};

const isDuplicateKeyError = (error: unknown) =>
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;

/** MongoDB store: one `portfolioSettings` document guarded by its revision. */
export const createMongoPortfolioStore = (): PortfolioStore => ({
    async read() {
        const document = await portfolioCollection().findOne({ _id: 'projects' });
        if (!document) return null;
        return {
            revision: document.revision,
            projects: Array.isArray(document.projects) ? document.projects : []
        };
    },
    async write(expectedRevision, projects, actorId) {
        const collection = portfolioCollection();
        const updatedAt = new Date();
        if (expectedRevision === 0) {
            try {
                await collection.insertOne({ _id: 'projects', revision: 1, projects, updatedAt, updatedBy: actorId });
                return true;
            } catch (error) {
                // Another administrator created the document first.
                if (isDuplicateKeyError(error)) return false;
                throw error;
            }
        }
        const result = await collection.updateOne(
            { _id: 'projects', revision: expectedRevision },
            { $set: { projects, updatedAt, updatedBy: actorId }, $inc: { revision: 1 } }
        );
        return result.modifiedCount === 1;
    }
});
