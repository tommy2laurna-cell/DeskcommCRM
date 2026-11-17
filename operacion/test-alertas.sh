#!/usr/bin/env bash
# M25 y die(): el JSON de Resend es válido con \ " y saltos de línea, y die() manda el mail de falla.
set -euo pipefail
D="$(cd "$(dirname "$0")" && pwd)"; W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
export ENV_FILE=/dev/null OPERACION_MAIL_DRYRUN="$W/mails" ALERTA_EMAIL=tomas@ci.test CLIENTE_NOMBRE="Cliente de Prueba"
source "$D/lib.sh"
orig=$'ruta C:\x "comillas"\nlínea 2\ttab\r'
j="{\"a\":\"$(json_str "$orig")\"}"
python3 -c 'import json,sys; assert json.loads(sys.argv[1])["a"]==sys.argv[2]' "$j" "$orig" || { echo "FALLA: json_str produce JSON inválido: $j"; exit 1; }
# die() sin SUPABASE_DB_URL: backup.sh sale con 1 y deja un mail.
rc=0; env -u SUPABASE_DB_URL BACKUP_PASSPHRASE=x BACKUP_REMOTE=x:y bash "$D/backup.sh" 2>/dev/null || rc=$?
[ "$rc" != 0 ] || { echo "FALLA: backup.sh debía fallar sin SUPABASE_DB_URL"; exit 1; }
grep -q 'Backup FALLÓ' "$W/mails" 2>/dev/null || { echo "FALLA: die() no mandó el mail de falla"; exit 1; }
[ "$(grep -c '^TO:' "$W/mails")" = 1 ] || { echo "FALLA: más de un mail por una sola falla"; exit 1; }
echo "alertas ok: json_str válido, die() avisa una sola vez"
