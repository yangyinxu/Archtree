#!/usr/bin/env bash
set -euo pipefail

cat >/etc/systemd/system/archtree-certbot-renew.service <<'EOF'
[Unit]
Description=Renew the Archtree public TLS certificate
After=network-online.target nginx.service

[Service]
Type=oneshot
ExecStart=/opt/archtree-certbot/bin/certbot renew --quiet --deploy-hook "/bin/systemctl reload nginx"
EOF

cat >/etc/systemd/system/archtree-certbot-renew.timer <<'EOF'
[Unit]
Description=Check the Archtree TLS certificate for renewal

[Timer]
OnCalendar=*-*-* 03,15:17:00
RandomizedDelaySec=3600
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now archtree-certbot-renew.timer
