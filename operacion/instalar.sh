#!/usr/bin/env bash
# Instala los dos cron (idempotente): backup 03:00 y salud cada 5 minutos.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
command -v rclone >/dev/null || die "falta rclone (curl https://rclone.org/install.sh | sudo bash)"
command -v openssl >/dev/null || die "falta openssl"
command -v docker >/dev/null || die "falta docker"
TMPC="$(mktemp)"; trap 'rm -f "$TMPC"' EXIT
(crontab -l 2>/dev/null || true) | grep -v 'operacion/\(backup\|salud\)\.sh' > "$TMPC" || true
{
  echo "0 3 * * * $OP_DIR/backup.sh >> /var/log/deskcomm-backup.log 2>&1"
  echo "*/5 * * * * $OP_DIR/salud.sh >> /var/log/deskcomm-salud.log 2>&1"
} >> "$TMPC"
crontab "$TMPC"
echo "cron instalado:"; crontab -l | grep 'operacion/'
