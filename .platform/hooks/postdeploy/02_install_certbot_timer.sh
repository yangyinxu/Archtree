#!/usr/bin/env bash
set -euo pipefail

SYSTEMD_DIR=${ARCHTREE_SYSTEMD_DIR:-/etc/systemd/system}
SYSTEMCTL=${ARCHTREE_SYSTEMCTL_BIN:-systemctl}
CONFIGURE_SOURCE=${ARCHTREE_CONFIGURE_HTTPS_SOURCE:-$(dirname "${BASH_SOURCE[0]}")/01_configure_https.sh}
CONFIGURE_INSTALLED=${ARCHTREE_CONFIGURE_HTTPS_INSTALL_PATH:-/usr/local/sbin/archtree-configure-https}
READY_MARKER=${ARCHTREE_HTTPS_READY_MARKER:-/var/lib/archtree-https/certificate-ready}

install -d -m 0755 "${SYSTEMD_DIR}" "$(dirname "${CONFIGURE_INSTALLED}")"
install -m 0755 "${CONFIGURE_SOURCE}" "${CONFIGURE_INSTALLED}"

cat >"${SYSTEMD_DIR}/archtree-certbot-bootstrap.service" <<EOF
[Unit]
Description=Recover the Archtree public TLS certificate after instance replacement
After=network-online.target nginx.service
Wants=network-online.target
ConditionPathExists=!${READY_MARKER}

[Service]
Type=oneshot
Environment=ARCHTREE_HTTPS_MODE=bootstrap
Environment=ARCHTREE_HTTPS_READY_MARKER=${READY_MARKER}
ExecStart=${CONFIGURE_INSTALLED}
EOF

cat >"${SYSTEMD_DIR}/archtree-certbot-bootstrap.timer" <<'EOF'
[Unit]
Description=Retry initial Archtree TLS certificate issuance

[Timer]
OnActiveSec=5min
OnCalendar=hourly
RandomizedDelaySec=5min
AccuracySec=1min
Persistent=true

[Install]
WantedBy=timers.target
EOF

cat >"${SYSTEMD_DIR}/archtree-certbot-renew.service" <<EOF
[Unit]
Description=Renew and reactivate the Archtree public TLS certificate
After=network-online.target nginx.service
Wants=network-online.target

[Service]
Type=oneshot
Environment=ARCHTREE_HTTPS_MODE=maintenance
Environment=ARCHTREE_HTTPS_READY_MARKER=${READY_MARKER}
ExecStart=${CONFIGURE_INSTALLED}
EOF

cat >"${SYSTEMD_DIR}/archtree-certbot-renew.timer" <<'EOF'
[Unit]
Description=Check the Archtree TLS certificate for renewal

[Timer]
OnCalendar=*-*-* 03,15:17:00
RandomizedDelaySec=5min
Persistent=true

[Install]
WantedBy=timers.target
EOF

"${SYSTEMCTL}" daemon-reload
for timer in archtree-certbot-bootstrap.timer archtree-certbot-renew.timer; do
  "${SYSTEMCTL}" enable "${timer}"
  "${SYSTEMCTL}" restart "${timer}"
done
