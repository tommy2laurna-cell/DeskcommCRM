#!/usr/bin/env bash
# Salud: cron cada 5 min contra /api/v1/health. 3 fallas seguidas -> UN mail de caída;
# cuando vuelve -> UN mail de recuperación. Distingue "Supabase pausado" de "caído".
#   */5 * * * *  /ruta/repo/operacion/salud.sh
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cargar_env
NOMBRE="${CLIENTE_NOMBRE:-${APP_NAME:-cliente sin nombre}}"
URL="${HEALTH_URL:-${NEXT_PUBLIC_APP_URL:-http://127.0.0.1:3000}/api/v1/health}"
UMBRAL="${SALUD_UMBRAL:-3}"
ESTADO="${SALUD_STATE_DIR:-$HOME/.deskcomm-salud}"; mkdir -p "$ESTADO"
FALLAS="$ESTADO/fallas"; AVISADO="$ESTADO/avisado"
BODY="$ESTADO/ultimo-cuerpo"

CODE="$(curl -sS -m 10 -o "$BODY" -w '%{http_code}' "$URL" 2>"$ESTADO/curl-err")"; RC=$?
ERR=""
if [ "$RC" -ne 0 ]; then
  ERR="no responde ($(tr -d '\n' < "$ESTADO/curl-err" | cut -c1-200))"
elif grep -q 'http_540\|proyecto_pausado' "$BODY" 2>/dev/null; then
  # 540 = "project paused" (https://supabase.com/docs/guides/troubleshooting/http-status-codes)
  ERR="SUPABASE PAUSADO: el plan free pausa el proyecto tras ~1 semana con poca actividad (https://supabase.com/docs/guides/platform/free-project-pausing). Entrar al dashboard de Supabase > proyecto > Resume project. Se restaura hasta 1 año después de la pausa."
elif [ "$CODE" != 200 ]; then
  DET="$(grep -o '"[a-z]*":{[^}]*"status":"down"[^}]*}' "$BODY" 2>/dev/null | cut -c1-300 | tr '\n' ' ')"
  ERR="HTTP $CODE. ${DET:-$(head -c 300 "$BODY" 2>/dev/null | tr '\n' ' ')}"
fi

if [ -z "$ERR" ]; then
  if [ -f "$AVISADO" ]; then
    enviar_mail "[$NOMBRE] volvió a funcionar" "El CRM de $NOMBRE responde otra vez ($URL).
Caída avisada desde: $(cat "$AVISADO")
Ahora: $(date -u +%Y-%m-%dT%H:%M:%SZ)" && rm -f "$AVISADO"
  fi
  rm -f "$FALLAS"; exit 0
fi

N=$(( $(cat "$FALLAS" 2>/dev/null || echo 0) + 1 )); echo "$N" > "$FALLAS"
log "falla $N/$UMBRAL: $ERR"
if [ "$N" -ge "$UMBRAL" ] && [ ! -f "$AVISADO" ]; then
  # el marcador se escribe solo si el mail salió: si falla, se reintenta en la próxima corrida
  AHORA="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  enviar_mail "[$NOMBRE] CRM caído" "El CRM de $NOMBRE falló $N veces seguidas (una cada 5 min).
URL: $URL
Error: $ERR
Hora: $AHORA" && echo "$AHORA" > "$AVISADO"
fi
exit 0
