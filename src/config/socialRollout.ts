/**
 * Social admission and Audio rooms are explicit opt-ins that default to off.
 * Rooms depend on social identity, so they are never reported as available
 * without social. Capability responses, the startup choice between the realtime
 * gateway and room wind-down, and the room and social admission checks all read
 * this one definition at the moment they decide, so the public shell and the
 * authenticated room surfaces cannot disagree.
 */
export const socialRollout = (environment: NodeJS.ProcessEnv = process.env) => {
    const socialEnabled = environment.FINITUDE_SOCIAL_ENABLED === 'true';
    return { socialEnabled, roomsEnabled: socialEnabled && environment.FINITUDE_ROOMS_ENABLED === 'true' };
};
