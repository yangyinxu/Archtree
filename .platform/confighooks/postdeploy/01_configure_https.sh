#!/usr/bin/env bash
set -euo pipefail

CONFIGURE_INSTALLED=${ARCHTREE_CONFIGURE_HTTPS_INSTALL_PATH:-/usr/local/sbin/archtree-configure-https}
CONFIGURE_FALLBACK=${ARCHTREE_CONFIGURE_HTTPS_SOURCE:-/var/app/current/.platform/hooks/postdeploy/01_configure_https.sh}

# Configuration-only deployments must react to corrected domain or ACME
# properties without waiting for another application release.
if [[ -x "${CONFIGURE_INSTALLED}" ]]; then
  CONFIGURE=${CONFIGURE_INSTALLED}
elif [[ -x "${CONFIGURE_FALLBACK}" ]]; then
  CONFIGURE=${CONFIGURE_FALLBACK}
else
  printf '[archtree-https] HTTPS configurator is unavailable after the configuration deployment.\n'
  exit 1
fi

ARCHTREE_HTTPS_MODE=deploy "${CONFIGURE}"
