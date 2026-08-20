import { createHash, randomUUID } from 'node:crypto';

export const catalogCreditSubjectTypes = ['artist', 'organization'] as const;
export type CatalogCreditSubjectType = typeof catalogCreditSubjectTypes[number];

export const catalogCreditRoles = [
    'primary',
    'featured',
    'performer',
    'composer',
    'producer',
    'remixer',
    'label',
    'publisher',
    'distributor',
    'presenter',
    'legacyUnspecified'
] as const;
export type CatalogCreditRole = typeof catalogCreditRoles[number];
export type AttributionStatus = 'documented' | 'unknown';

export interface CatalogCredit {
    creditId: string;
    subjectType: CatalogCreditSubjectType;
    subjectId: string;
    role: CatalogCreditRole;
    order: number;
}

const artistRoles = new Set<CatalogCreditRole>([
    'primary',
    'featured',
    'performer',
    'composer',
    'producer',
    'remixer',
    'legacyUnspecified'
]);
const organizationRoles = new Set<CatalogCreditRole>([
    'label',
    'publisher',
    'distributor',
    'presenter',
    'legacyUnspecified'
]);
const creditIdPattern = /^[A-Za-z0-9_-]{8,100}$/;
const objectIdPattern = /^[0-9a-f]{24}$/;

export class CatalogCreditValidationError extends Error {
    readonly statusCode = 400;
    readonly code = 'catalog_credit_invalid';

    constructor(message: string) {
        super(message);
    }
}

const normalizedSubjectType = (value: unknown): CatalogCreditSubjectType => {
    if (value === 'artist' || value === 'organization') return value;
    throw new CatalogCreditValidationError('Credit subjectType must be artist or organization.');
};

const normalizedRole = (value: unknown): CatalogCreditRole => {
    if (catalogCreditRoles.includes(value as CatalogCreditRole)) return value as CatalogCreditRole;
    throw new CatalogCreditValidationError('Credit role is not supported.');
};

const normalizedSubjectId = (value: unknown) => {
    const subjectId = String(value ?? '').trim().toLowerCase();
    if (!objectIdPattern.test(subjectId)) {
        throw new CatalogCreditValidationError('Credit subjectId must be a canonical ID.');
    }
    return subjectId;
};

const normalizedCreditId = (value: unknown) => {
    const creditId = String(value ?? '').trim();
    if (!creditIdPattern.test(creditId)) {
        throw new CatalogCreditValidationError('Credit creditId is invalid.');
    }
    return creditId;
};

/** Creates an opaque stable ID for new interactive Credits. */
export const createCatalogCreditId = () => randomUUID().replace(/-/g, '_');

/** Creates a deterministic Credit ID for an idempotent legacy migration. */
export const migratedCatalogCreditId = (
    ownerType: 'album' | 'audioTrack',
    ownerId: string,
    subjectType: CatalogCreditSubjectType,
    subjectId: string,
    role: CatalogCreditRole
) => createHash('sha256')
    .update(`${ownerType}\0${ownerId}\0${subjectType}\0${subjectId}\0${role}`, 'utf8')
    .digest('base64url')
    .slice(0, 32);

/** Builds deterministic Credits for a legacy artist-ID write during the compatibility window. */
export const creditsForLegacyArtistIds = (
    ownerType: 'album' | 'audioTrack',
    ownerId: string,
    artistIds: readonly string[],
    role: Extract<CatalogCreditRole, 'primary' | 'legacyUnspecified'>
) => normalizeCatalogCredits([...new Set(artistIds.map((id) => id.trim().toLowerCase()))]
    .filter(Boolean)
    .map((subjectId, order) => ({
        creditId: migratedCatalogCreditId(ownerType, ownerId, 'artist', subjectId, role),
        subjectType: 'artist',
        subjectId,
        role,
        order
    })));

/** Applies a legacy artist-ID edit without discarding Organization or known-role Credits. */
export const mergeLegacyArtistIdsIntoCredits = (
    ownerType: 'album' | 'audioTrack',
    ownerId: string,
    existingValue: unknown,
    artistIds: readonly string[]
) => {
    const existing = Array.isArray(existingValue) ? normalizeCatalogCredits(existingValue) : [];
    const requestedArtistIds = [...new Set(artistIds.map((id) => id.trim().toLowerCase()))];
    const retainedOrganizations = existing.filter((credit) => credit.subjectType === 'organization');
    const retainedArtists = existing.filter((credit) => credit.subjectType === 'artist'
        && requestedArtistIds.includes(credit.subjectId));
    const representedArtists = new Set(retainedArtists.map((credit) => credit.subjectId));
    const addedArtists = requestedArtistIds
        .filter((subjectId) => !representedArtists.has(subjectId))
        .map((subjectId) => ({
            creditId: migratedCatalogCreditId(
                ownerType,
                ownerId,
                'artist',
                subjectId,
                'legacyUnspecified'
            ),
            subjectType: 'artist' as const,
            subjectId,
            role: 'legacyUnspecified' as const,
            order: 0
        }));
    return normalizeCatalogCredits([
        ...retainedArtists,
        ...addedArtists,
        ...retainedOrganizations
    ]);
};

/** Validates and canonicalizes one complete ordered Credit list. */
export const normalizeCatalogCredits = (
    value: unknown,
    maximumCredits: number = 50
): CatalogCredit[] => {
    if (!Array.isArray(value)) {
        throw new CatalogCreditValidationError('Credits must be an array.');
    }
    if (value.length > maximumCredits) {
        throw new CatalogCreditValidationError(`No more than ${maximumCredits} Credits are allowed.`);
    }

    const normalized = value.map((raw, index) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            throw new CatalogCreditValidationError(`Credit ${index + 1} must be an object.`);
        }
        const source = raw as Record<string, unknown>;
        const subjectType = normalizedSubjectType(source.subjectType);
        const role = normalizedRole(source.role);
        const permittedRoles = subjectType === 'artist' ? artistRoles : organizationRoles;
        if (!permittedRoles.has(role)) {
            throw new CatalogCreditValidationError(
                `Credit role ${role} is not valid for ${subjectType} subjects.`
            );
        }
        return {
            creditId: normalizedCreditId(source.creditId),
            subjectType,
            subjectId: normalizedSubjectId(source.subjectId),
            role,
            order: index
        } satisfies CatalogCredit;
    });

    const seenCreditIds = new Set<string>();
    const seenRelationships = new Set<string>();
    for (const credit of normalized) {
        if (seenCreditIds.has(credit.creditId)) {
            throw new CatalogCreditValidationError('Credit IDs must be unique within one item.');
        }
        seenCreditIds.add(credit.creditId);
        const relationship = `${credit.subjectType}:${credit.subjectId}:${credit.role}`;
        if (seenRelationships.has(relationship)) {
            throw new CatalogCreditValidationError('Duplicate subject and role Credits are not allowed.');
        }
        seenRelationships.add(relationship);
    }
    return normalized;
};

/** Enforces the publication invariant without manufacturing an unknown subject. */
export const validateAttribution = (
    status: unknown,
    credits: readonly CatalogCredit[]
): AttributionStatus => {
    if (status !== 'documented' && status !== 'unknown') {
        throw new CatalogCreditValidationError('attributionStatus must be documented or unknown.');
    }
    if (status === 'documented' && credits.length === 0) {
        throw new CatalogCreditValidationError('Documented attribution requires at least one Credit.');
    }
    if (status === 'unknown' && credits.length > 0) {
        throw new CatalogCreditValidationError('Unknown attribution cannot contain documented Credits.');
    }
    return status;
};

/** Projects the ordered legacy MediaTrack Artist IDs from visible Artist Credits. */
export const legacyTrackArtistIdsFromCredits = (credits: readonly CatalogCredit[]) => [
    ...new Set(credits
        .filter((credit) => credit.subjectType === 'artist')
        .sort((left, right) => left.order - right.order)
        .map((credit) => credit.subjectId))
];

/** Projects only formal Album ownership for clients that render albumIds as Discography. */
export const legacyAlbumArtistIdsFromCredits = (credits: readonly CatalogCredit[]) => [
    ...new Set(credits
        .filter((credit) => credit.subjectType === 'artist' && credit.role === 'primary')
        .sort((left, right) => left.order - right.order)
        .map((credit) => credit.subjectId))
];

export type ArtistAlbumCreditSection =
    | 'discography'
    | 'collaborations'
    | 'appearsOn'
    | 'credits'
    | null;

/** Classifies one Album once for an Artist using the canonical precedence rule. */
export const classifyArtistAlbumCredit = (
    artistId: string,
    albumCredits: readonly CatalogCredit[],
    soundtrackCredits: readonly CatalogCredit[]
): ArtistAlbumCreditSection => {
    const normalizedArtistId = normalizedSubjectId(artistId);
    const albumRoles = new Set(albumCredits
        .filter((credit) => credit.subjectType === 'artist' && credit.subjectId === normalizedArtistId)
        .map((credit) => credit.role));
    if (albumRoles.has('primary')) return 'discography';
    if (albumRoles.has('featured')) return 'collaborations';

    const trackRoles = new Set(soundtrackCredits
        .filter((credit) => credit.subjectType === 'artist' && credit.subjectId === normalizedArtistId)
        .map((credit) => credit.role));
    if (['primary', 'featured', 'performer', 'legacyUnspecified']
        .some((role) => trackRoles.has(role as CatalogCreditRole))) {
        return 'appearsOn';
    }
    if (['composer', 'producer', 'remixer']
        .some((role) => albumRoles.has(role as CatalogCreditRole)
            || trackRoles.has(role as CatalogCreditRole))) {
        return 'credits';
    }
    return null;
};
