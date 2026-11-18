#!/usr/bin/env bash
# salud.sh contra un servidor falso: 3 fallas -> 1 aviso; sigue caído -> sin más avisos; vuelve -> 1 aviso. Pausa de Supabase se nombra.
set -euo pipefail
D="$(cd "$(dirname "$0")" && pwd)"; W="$(mktemp -d)"; trap 'kill $SRV 2>/dev/null || true; rm -rf "$W"' EXIT
PORT="${PORT:-18765}"
cat > "$W/srv.py" <<PY
import http.server, sys
M = sys.argv[1]
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        modo = open(M).read().strip()
        if modo == "ok": c, b = 200, '{"data":{"status":"healthy"}}'
        elif modo == "pausa": c, b = 503, '{"data":{"status":"unhealthy","checks":{"supabase":{"status":"down","reason":"proyecto_pausado"}}}}'
        else: c, b = 503, '{"data":{"status":"unhealthy","checks":{"redis":{"status":"down","reason":"inalcanzable"}}}}'
        self.send_response(c); self.send_header("Content-Type","application/json"); self.end_headers(); self.wfile.write(b.encode())
    def log_message(self,*a): pass
http.server.HTTPServer(("127.0.0.1", $PORT), H).serve_forever()
PY
echo ok > "$W/modo"; python3 "$W/srv.py" "$W/modo" & SRV=$!; sleep 1
export ENV_FILE=/dev/null HEALTH_URL="http://127.0.0.1:$PORT/api/v1/health" SALUD_STATE_DIR="$W/estado" OPERACION_MAIL_DRYRUN="$W/mails" ALERTA_EMAIL=tomas@ci.test CLIENTE_NOMBRE="Cliente de Prueba"
s() { bash "$D/salud.sh" 2>/dev/null; }
mails() { grep -c '^TO:' "$W/mails" 2>/dev/null || echo 0; }
afirmar() { [ "$1" = "$2" ] || { echo "FALLA: $3 (esperaba $2, hubo $1)"; cat "$W/mails" 2>/dev/null; exit 1; }; }
s; afirmar "$(mails)" 0 "sano no avisa"
echo pausa > "$W/modo"; s; s; afirmar "$(mails)" 0 "2 fallas no avisan"
s; afirmar "$(mails)" 1 "la 3.ª falla avisa"
grep -q 'SUPABASE PAUSADO' "$W/mails" || { echo "FALLA: el aviso no dice que Supabase está pausado"; exit 1; }
grep -q 'Cliente de Prueba' "$W/mails" || { echo "FALLA: falta el nombre del cliente"; exit 1; }
s; s; afirmar "$(mails)" 1 "caído sostenido: un solo aviso"
echo ok > "$W/modo"; s; afirmar "$(mails)" 2 "vuelve: un aviso de recuperación"
s; afirmar "$(mails)" 2 "sano otra vez: nada más"
echo caido > "$W/modo"; s; s; s; afirmar "$(mails)" 3 "nueva caída: nuevo aviso"
kill $SRV; sleep 0.5; : > "$W/mails"; rm -rf "$W/estado"; s; s; s
grep -q 'no responde' "$W/mails" || { echo "FALLA: servidor apagado debería decir 'no responde'"; exit 1; }
echo "salud ok: umbral 3, un aviso por caída, aviso al volver, pausa de Supabase nombrada, servidor apagado"
