/**
 * Motion previews are independently opt-in in every environment. Disabling hides every public
 * preview at once but keeps stored previews and their lifecycle evidence for later reconciliation.
 */
export const isMotionPreviewEnabled = (environment: NodeJS.ProcessEnv = process.env) =>
    environment.FINITUDE_MOTION_PREVIEWS_ENABLED?.trim().toLowerCase() === 'true';
