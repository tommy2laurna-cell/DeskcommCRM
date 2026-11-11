#!/usr/bin/env bash
# Muestrea `docker stats --no-stream` cada 30 s a un CSV: epoch,nombre,uso_en_bytes.
# Uso: ram.sh <salida.csv>   (corre hasta que lo maten)
set -u
OUT="$1"
: > "$OUT"
while true; do
  ts=$(date +%s)
  docker stats --no-stream --format '{{.Name}}|{{.MemUsage}}' 2>/dev/null \
    | while IFS='|' read -r nombre uso; do echo "$ts|$nombre|${uso%% /*}"; done >> "$OUT"
  sleep 30
done
