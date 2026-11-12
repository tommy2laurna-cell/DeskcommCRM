#!/usr/bin/env bash
# Funciones compartidas de operacion/ (backup, restauracion, salud).
# Se hace `source` desde los otros scripts. Credenciales: SOLO del .env del VPS.

OP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$OP_DIR/.." && pwd)"
ENV_FILE="${ENV_FILE:-$REPO_DIR/.env}"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# Carga KEY=valor del .env SIN ejecutarlo (no hace source) y sin pisar lo que
# ya esté en el entorno. Cron arranca con un entorno vacío, por eso se lee acá.
cargar_env() {
  [ -f "$ENV_FILE" ] || return 0
  local k v
  while IFS='=' read -r k v || [ -n "$k" ]; do
    case "$k" in ''|'#'*|*[!A-Za-z0-9_]*) continue ;; esac
    v="${v%$'\r'}"
    case "$v" in \"*\") v="${v#\"}"; v="${v%\"}" ;; \'*\') v="${v#\'}"; v="${v%\'}" ;; esac
    [ -z "${!k+x}" ] && export "$k=$v"
  done < "$ENV_FILE"
  return 0
}

exigir() { # exigir VAR...
  local v
  for v in "$@"; do [ -n "${!v:-}" ] || die "falta $v (definila en $ENV_FILE)"; done
}

# URL de la base: la de schema/admin si existe, si no la del app (igual que el kit).
url_base() { printf '%s' "${SUPABASE_DB_ADMIN_URL:-${SUPABASE_DB_URL:-}}"; }

# Herramientas de Postgres vía contenedor: no exigen pg_dump en el VPS y el major
# queda fijo en 17 (el de Supabase). PG_DOCKER_ARGS="--network host" en CI.
pg_tool() {
  # shellcheck disable=SC2086
  docker run --rm -i ${PG_DOCKER_ARGS:-} "${PG_IMAGE:-postgres:17-alpine}" "$@"
}

# Las herramientas tienen que ser del MISMO major que el servidor: un pg_dump 17 contra
# un servidor 15 escribe `SET transaction_timeout` y el pg_restore se cae. Detecta el major
# del servidor de URL y fija PG_IMAGE (si no se pudo, queda postgres:17-alpine).
elegir_imagen() { # elegir_imagen URL
  [ -z "${PG_IMAGE:-}" ] || return 0
  local n
  # shellcheck disable=SC2086
  n="$(docker run --rm -i ${PG_DOCKER_ARGS:-} postgres:17-alpine psql "$1" -tAq -c 'show server_version_num' 2>/dev/null | tr -d '[:space:]')" || n=''
  case "$n" in [0-9][0-9][0-9][0-9][0-9][0-9]) PG_IMAGE="postgres:$((n / 10000))-alpine"; export PG_IMAGE ;; esac
  log "herramientas de Postgres: ${PG_IMAGE:-postgres:17-alpine}"
}

cifrar()   { openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE; }
descifrar(){ openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE; }

# Recibe sellos (YYYYMMDDTHHMMSSZ) por stdin; imprime los que hay que BORRAR.
# Se queda con 1 por día (el último), los 14 días más nuevos, y además los
# 4 domingos más nuevos de entre los más viejos. Un domingo dentro de los 14
# diarios no cuenta como semanal.
retener_stamps() {
  local diarios="${RETENER_DIARIOS:-14}" semanales="${RETENER_SEMANALES:-4}"
  local -a todos=(); local s
  while IFS= read -r s; do [[ "$s" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] && todos+=("$s"); done < <(sort -ru)
  local i=0 sem=0 dia ult='' dow
  for s in "${todos[@]}"; do
    dia="${s:0:8}"
    if [ "$dia" = "$ult" ]; then echo "$s"; continue; fi   # segundo backup del mismo día
    ult="$dia"; i=$((i+1))
    [ "$i" -le "$diarios" ] && continue
    dow="$(date -u -d "${dia:0:4}-${dia:4:2}-${dia:6:2}" +%u)"
    if [ "$dow" = 7 ] && [ "$sem" -lt "$semanales" ]; then sem=$((sem+1)); continue; fi
    echo "$s"
  done
}

# ── Mail ─────────────────────────────────────────────────────────────────────
json_str() { printf '%s' "$1" | sed -e 's/\/\\/g' -e 's/"/\\"/g' -e 's/\t/\t/g' | awk 'BEGIN{ORS="\n"}1'; }

# enviar_mail "asunto" "cuerpo" → Resend del cliente si hay clave; si no, SMTP.
# OPERACION_MAIL_DRYRUN=<archivo> anota el mail en vez de mandarlo (tests).
enviar_mail() {
  local asunto="$1" cuerpo="$2" para="${ALERTA_EMAIL:-}"
  [ -n "$para" ] || { log "ALERTA_EMAIL vacío: no hay a quién avisar"; return 1; }
  if [ -n "${OPERACION_MAIL_DRYRUN:-}" ]; then
    printf 'TO: %s\nSUBJECT: %s\n%s\n---\n' "$para" "$asunto" "$cuerpo" >> "$OPERACION_MAIL_DRYRUN"; return 0
  fi
  if [ -n "${RESEND_API_KEY:-}" ] && [ -n "${RESEND_FROM_EMAIL:-}" ]; then
    local code
    code="$(curl -sS -m 20 -o /dev/null -w '%{http_code}' https://api.resend.com/emails \
      -H "Authorization: Bearer $RESEND_API_KEY" -H 'Content-Type: application/json' \
      -d "{\"from\":\"$(json_str "$RESEND_FROM_EMAIL")\",\"to\":[\"$(json_str "$para")\"],\"subject\":\"$(json_str "$asunto")\",\"text\":\"$(json_str "$cuerpo")\"}" 2>/dev/null || echo 000)"
    case "$code" in 2*) return 0 ;; esac
    log "Resend respondió $code; pruebo SMTP"
  fi
  if [ -n "${SMTP_URL:-}" ] && [ -n "${SMTP_FROM:-}" ]; then
    local asu64; asu64="$(printf '%s' "$asunto" | base64 | tr -d '\n')"
    printf 'From: %s\nTo: %s\nSubject: =?UTF-8?B?%s?=\nMIME-Version: 1.0\nContent-Type: text/plain; charset=UTF-8\n\n%s\n' \
      "$SMTP_FROM" "$para" "$asu64" "$cuerpo" \
      | curl -sS -m 30 --ssl-reqd "$SMTP_URL" --mail-from "$SMTP_FROM" --mail-rcpt "$para" \
          ${SMTP_USER:+--user "$SMTP_USER:${SMTP_PASS:-}"} -T - >/dev/null && return 0
  fi
  log "no pude mandar el mail (ni Resend ni SMTP)"; return 1
}
