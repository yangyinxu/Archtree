import { writeReleaseProvenance } from './release-provenance.mjs';

// Paths are fixed by the workflow; this command cannot assert success for omitted or skipped gates.
writeReleaseProvenance({ bundlePath: `archtree-eb-${process.env.GITHUB_SHA}.zip`, outputPath: 'release-provenance.json' })
  .catch(error => { console.error(error.message); process.exitCode = 1; });
