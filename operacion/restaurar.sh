#!/usr/bin/env bash
# Restaura un backup de backup.sh en una base VACÍA (Supabase nuevo con auth listo, sin tablas en public).
#   RESTORE_DB_URL=postgresql://... operacion/restaurar.sh [latest|<sello>]
# Opcional: MEDIA_RESTORE_VOLUME=<volumen> restaura también la media de WhatsApp.
#           RESTORE_APPLY_BASELINE=0 salta el re-aplicado de supabase/baseline.sql (por defecto 1).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cargar_env
exigir BACKUP_PASSPHRASE BACKUP_REMOTE RESTORE_DB_URL
export BACKUP_PASSPHRASE
DEST="$RESTORE_DB_URL"
[ "$DEST" != "$(url_base)" ] || die "RESTORE_DB_URL es la base en uso: restaurar es para una base NUEVA"

SEL="${1:-latest}"
if [ "$SEL" = latest ]; then
  SEL="$(rclone lsf "$BACKUP_REMOTE" | sed -n 's/^db-\([0-9]\{8\}T[0-9]\{6\}Z\)\.dump\.enc$/\1/p' | sort | tail -1)"
  [ -n "$SEL" ] || die "no hay backups en $BACKUP_REMOTE"
fi
T0=$(date +%s)
log "restaurando el backup $SEL en la base nueva"

elegir_imagen "$DEST"
# 1) La base destino tiene que estar vacía: restaurar encima de datos mezcla dos historias.
q() { pg_tool psql "$DEST" -v ON_ERROR_STOP=1 -tAq -c "$1"; }
N="$(q "select count(*) from information_schema.tables where table_schema in ('public','private')")"
[ "$N" = 0 ] || die "la base destino ya tiene $N tablas en public/private: usá una base vacía"
[ "$(q "select count(*) from auth.users")" = 0 ] || die "auth.users del destino no está vacío"

# 2) Extensiones (las mismas que crea el install.sh) y datos
q "create schema if not exists extensions; create extension if not exists \"uuid-ossp\" with schema extensions; create extension if not exists pgcrypto with schema extensions; create extension if not exists vector with schema public; create extension if not exists citext with schema public; create extension if not exists pg_trgm with schema public;" >/dev/null
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
bajar() { rclone copyto "${BACKUP_REMOTE%/}/$1" "$TMP/$1" --checksum; }
bajar "auth-$SEL.dump.enc"; bajar "db-$SEL.dump.enc"
T1=$(date +%s)
# auth primero: las tablas de public tienen FK a auth.users
descifrar < "$TMP/auth-$SEL.dump.enc" | pg_tool pg_restore --dbname="$DEST" --data-only --no-owner --exit-on-error
descifrar < "$TMP/db-$SEL.dump.enc"   | pg_tool pg_restore --dbname="$DEST" --no-owner --no-privileges --exit-on-error
T2=$(date +%s)

# 3) Lo que no viaja en el dump (policies de storage, publicación realtime): el baseline es idempotente
if [ "${RESTORE_APPLY_BASELINE:-1}" = 1 ] && [ -f "$REPO_DIR/supabase/baseline.sql" ]; then
  log "re-aplicando supabase/baseline.sql (idempotente)"
  pg_tool psql "$DEST" -q -v ON_ERROR_STOP=1 < "$REPO_DIR/supabase/baseline.sql" >/dev/null
fi
T3=$(date +%s)

# 4) Media
if [ -n "${MEDIA_RESTORE_VOLUME:-}" ] && rclone lsf "$BACKUP_REMOTE" | grep -qx "media-$SEL.tgz.enc"; then
  bajar "media-$SEL.tgz.enc"
  docker volume create "$MEDIA_RESTORE_VOLUME" >/dev/null
  descifrar < "$TMP/media-$SEL.tgz.enc" | docker run --rm -i -v "$MEDIA_RESTORE_VOLUME:/data" alpine:3.20 tar xzf - -C /data
  log "media restaurada en $MEDIA_RESTORE_VOLUME"
fi
T4=$(date +%s)
echo "restauracion_ok stamp=$SEL descarga_s=$((T1-T0)) datos_s=$((T2-T1)) baseline_s=$((T3-T2)) media_s=$((T4-T3)) total_s=$((T4-T0))"
