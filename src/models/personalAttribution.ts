/** Private account association, distinct from public Artist and Organization Credits. */
export interface PersonalAttribution {
    /** Private account binding; never projected into public catalog metadata. */
    ownerId: string;
    publicName: string;
}

export class PersonalAttributionValidationError extends Error {
    readonly statusCode = 400;
    readonly code = 'personal_attribution_invalid';

    constructor() {
        super('Personal attribution requires an account ID and a valid explicit public signature.');
    }
}

const normalizedPersonalName = (publicName: unknown): string => {
    if (typeof publicName !== 'string' || publicName.length > 500) throw new PersonalAttributionValidationError();
    const name = publicName.normalize('NFC').trim();
    if (name.length > 200 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)
        || /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(name)
        || name !== '' && !/[^\p{White_Space}\p{M}\p{Default_Ignorable_Code_Point}]/u.test(name)) {
        throw new PersonalAttributionValidationError();
    }
    return name;
};

/** Creation always binds an authoritative account; a blank signature never copies account metadata. */
export const createPersonalAttribution = (
    ownerId: unknown,
    publicName: unknown = ''
): PersonalAttribution => {
    if (typeof ownerId !== 'string' || !/^[0-9a-f]{24}$/i.test(ownerId)) throw new PersonalAttributionValidationError();
    return { ownerId: ownerId.toLowerCase(), publicName: normalizedPersonalName(publicName) };
};

/** A malformed stored association never becomes a public signature or makes catalog reads fail. */
export const readPersonalAttribution = (value: unknown): PersonalAttribution | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (typeof record.publicName !== 'string') return null;
    try {
        return createPersonalAttribution(record.ownerId, record.publicName);
    } catch { return null; }
};
