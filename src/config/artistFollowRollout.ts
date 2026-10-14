/** Follow is independently opt-in in every environment; disabling retains private reads/removal. */
export const isArtistFollowEnabled = (environment: NodeJS.ProcessEnv = process.env) =>
    environment.FINITUDE_ARTIST_FOLLOWS_ENABLED?.trim().toLowerCase() === 'true';

/** This is a response-version negotiation, never authorization. */
export const supportsArtistFollowHome = (header: unknown) => header === '1';
