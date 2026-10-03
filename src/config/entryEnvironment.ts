/**
 * Loads `.env` for the `tsx src/app.ts` server entry before any application module reads configuration.
 *
 * Application modules never load `.env` themselves: tests import them from the repository root, where a
 * developer's private `.env` would otherwise reach test processes. `src/app.ts` imports this module first,
 * and the check below matches only when that file is the process entry, not when a test imports `createApp`.
 * `dotenv/config` honors `DOTENV_CONFIG_PATH`, which the server test runner points at the null device.
 */
if (typeof require !== 'undefined' && require.main?.filename === require.resolve('../app')) {
    require('dotenv/config');
}
