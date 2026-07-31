#!/usr/bin/env bash
set -euo pipefail

# Keep Certbot isolated from the platform Python installation.
CERTBOT_VENV=/opt/archtree-certbot

if [[ ! -x "${CERTBOT_VENV}/bin/certbot" ]]; then
  python3 -m venv "${CERTBOT_VENV}"
  "${CERTBOT_VENV}/bin/pip" install --disable-pip-version-check --no-cache-dir certbot
fi

install -d -m 0755 /var/www/archtree-acme/.well-known/acme-challenge
