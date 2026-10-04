import { socialConfig } from './playwright.social.config';

/**
 * Non-blocking cross-engine audio drift projects (see `quarantinedSocialProjects`). Linux CI runs them after the
 * blocking social gate with continue-on-error; their evidence lands in test-results/social-quarantined.
 */
export default socialConfig('quarantined');
