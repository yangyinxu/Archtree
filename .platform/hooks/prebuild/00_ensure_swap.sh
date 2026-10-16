#!/usr/bin/env bash
set -euo pipefail

# Gives the 1 GiB single instance a swap file before Elastic Beanstalk runs
# `npm install`. Every application and configuration deployment reinstalls
# dependencies while Archtree keeps serving, and without swap the kernel OOM
# killer can end that install (exit 137), failing the deployment. The file is
# created once, enabled on every run, and kept across reboots through fstab.

# Paths and tools are overridable only so tests can run the hook against an
# isolated filesystem.
SWAP_FILE=${ARCHTREE_SWAP_FILE:-/var/swap/archtree.swap}
SWAP_MIB=${ARCHTREE_SWAP_MIB:-1024}
FSTAB=${ARCHTREE_SWAP_FSTAB:-/etc/fstab}
SWAPON=${ARCHTREE_SWAPON_BIN:-swapon}
MKSWAP=${ARCHTREE_MKSWAP_BIN:-mkswap}
FALLOCATE=${ARCHTREE_FALLOCATE_BIN:-fallocate}

log() {
  printf '[archtree-swap] %s\n' "$*"
}

if [[ ! "${SWAP_MIB}" =~ ^[1-9][0-9]{2,4}$ ]]; then
  log "Invalid swap size ${SWAP_MIB}; expected 100 to 99999 MiB."
  exit 1
fi

if "${SWAPON}" --show=NAME --noheadings 2>/dev/null | grep -Fxq "${SWAP_FILE}"; then
  exit 0
fi

if [[ ! -f "${SWAP_FILE}" ]]; then
  install -d -m 0700 "$(dirname "${SWAP_FILE}")"
  "${FALLOCATE}" -l "${SWAP_MIB}M" "${SWAP_FILE}"
  chmod 0600 "${SWAP_FILE}"
  "${MKSWAP}" "${SWAP_FILE}" >/dev/null
fi

# A swap failure must not block a deployment that may still fit in memory.
if ! "${SWAPON}" "${SWAP_FILE}"; then
  log "Could not enable ${SWAP_FILE}; continuing without it."
  exit 0
fi
if ! grep -Fq "${SWAP_FILE} " "${FSTAB}" 2>/dev/null; then
  printf '%s none swap defaults,nofail 0 0\n' "${SWAP_FILE}" >>"${FSTAB}"
fi
log "Enabled ${SWAP_MIB} MiB swap at ${SWAP_FILE}."
