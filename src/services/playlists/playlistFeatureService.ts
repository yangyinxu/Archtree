/**
 * Keeps production rollout fail-closed while preserving an enabled local/test
 * default. Deployments must explicitly opt in after indexes and lifecycle gates pass.
 */
export const isPlaylistFeatureEnabled = (
    environment: NodeJS.ProcessEnv = process.env
) => {
    const configured = String(environment.FINITUDE_PLAYLISTS_ENABLED ?? '')
        .trim()
        .toLowerCase();
    if (configured === 'true') return true;
    if (configured === 'false') return false;
    return environment.NODE_ENV !== 'production';
};
