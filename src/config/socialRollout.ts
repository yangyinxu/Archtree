/**
 * Social admission and Audio rooms are explicit opt-ins that default to off.
 * Rooms depend on social identity, so they are never reported as available
 * without social. Every capability response reads this one definition so the
 * public shell and the authenticated room surfaces cannot disagree.
 */
export const socialRollout = (environment: NodeJS.ProcessEnv = process.env) => {
    const socialEnabled = environment.FINITUDE_SOCIAL_ENABLED === 'true';
    return { socialEnabled, roomsEnabled: socialEnabled && environment.FINITUDE_ROOMS_ENABLED === 'true' };
};
