#!/usr/bin/env bash
set -euo pipefail

INSTALLED=${OOTD_COHOST_INSTALL_PATH:-/usr/local/sbin/ootd-cohost}
FALLBACK=${OOTD_COHOST_SOURCE:-/var/app/current/.platform/hooks/postdeploy/03_cohost_ootd.sh}

# Configuration-only deployments roll OOTD forward when its pinned artifact,
# secret or route properties change, without another Archtree release. The
# configurator itself never fails an Archtree deployment.
if [[ -x "${INSTALLED}" ]]; then
  CONFIGURE=${INSTALLED}
elif [[ -x "${FALLBACK}" ]]; then
  CONFIGURE=${FALLBACK}
else
  printf '[ootd-cohost] The OOTD co-host configurator is unavailable; skipping.\n'
  exit 0
fi

OOTD_COHOST_MODE=deploy "${CONFIGURE}"
