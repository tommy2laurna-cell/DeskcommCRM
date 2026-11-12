#!/usr/bin/env bash
# Backup diario: pg_dump de la base del cliente + tar del volumen waha-media,
# cifrado con AES-256 y subido FUERA del VPS con rclone. Retención 14 diarios + 4 semanales.
#   crontab:  0 3 * * *  /ruta/repo/operacion/backup.sh >> /var/log/deskcomm-backup.log 2>&1
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cargar_env
exigir BACKUP_PASSPHRASE BACKUP_REMOTE
URL="$(url_base)"; [ -n "$URL" ] || die "falta SUPABASE_DB_URL en $ENV_FILE"

# Un backup que falla en silencio es la peor falla: se descubre al restaurar. Avisa por mail.
avisar_falla() {
  enviar_mail "[${CLIENTE_NOMBRE:-${APP_NAME:-cliente}}] Backup FALLÓ" "El backup diario de ${CLIENTE_NOMBRE:-${APP_NAME:-cliente}} falló (línea $1). Revisar /var/log/deskcomm-backup.log en el VPS. Hora: $(date -u +%Y-%m-%dT%H:%M:%SZ)" || true
}
trap 'avisar_falla $LINENO' ERR
T0=$(date +%s); STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export BACKUP_PASSPHRASE
elegir_imagen "$URL"

# 1) Base. Dos dumps porque pg_dump no mezcla esquema+datos de public/private con
#    solo-datos de auth: sin auth.users las FK a usuarios no cierran al restaurar.
log "dump de public + private"
pg_tool pg_dump "$URL" --format=custom --no-owner --no-privileges -n public -n private | cifrar > "$TMP/db-$STAMP.dump.enc"
log "dump de auth.users + auth.identities (solo datos)"
pg_tool pg_dump "$URL" --format=custom --no-owner --no-privileges --data-only -t auth.users -t auth.identities | cifrar > "$TMP/auth-$STAMP.dump.enc"
# Verificación: que se pueda descifrar y que pg_restore lea el índice. Un backup que no se lee es peor que ninguno.
for f in db auth; do
  descifrar < "$TMP/$f-$STAMP.dump.enc" | pg_tool pg_restore --list >/dev/null || die "el backup $f no se puede leer"
done
T1=$(date +%s)

# 2) Media de WhatsApp (volumen waha-media)
VOL="${MEDIA_VOLUME:-$(docker volume ls -q | grep -E '(^|_)waha-media$' | head -1 || true)}"
if [ -n "$VOL" ]; then
  log "tar del volumen $VOL"
  docker run --rm -v "$VOL:/data:ro" alpine:3.20 tar czf - -C /data . | cifrar > "$TMP/media-$STAMP.tgz.enc"
else
  log "AVISO: no encontré el volumen waha-media; el backup sale sin media"
fi
T2=$(date +%s)

# 3) Afuera del VPS
log "subiendo a $BACKUP_REMOTE"
for f in "$TMP"/*.enc; do rclone copyto "$f" "${BACKUP_REMOTE%/}/$(basename "$f")" --checksum; done
T3=$(date +%s)

# 4) Retención sobre lo que hay en el remoto
rclone lsf "$BACKUP_REMOTE" 2>/dev/null | sed -n 's/^[a-z]*-\([0-9]\{8\}T[0-9]\{6\}Z\)\..*/\1/p' | retener_stamps | while read -r s; do
  log "retención: borro $s"
  for n in "db-$s.dump.enc" "auth-$s.dump.enc" "media-$s.tgz.enc"; do rclone deletefile "${BACKUP_REMOTE%/}/$n" 2>/dev/null || true; done
done

echo "backup_ok stamp=$STAMP base_s=$((T1-T0)) media_s=$((T2-T1)) subida_s=$((T3-T2)) total_s=$((T3-T0)) bytes=$(du -cb "$TMP"/*.enc | tail -1 | cut -f1)"
