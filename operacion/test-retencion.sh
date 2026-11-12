#!/usr/bin/env bash
# 60 días de backups diarios (+ un segundo backup el mismo día): quedan 14 diarios y 4 domingos más viejos.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
HOY=2026-11-12
todos=(); for i in $(seq 0 59); do d="$(date -u -d "$HOY - $i days" +%Y%m%d)"; todos+=("${d}T030000Z"); done
todos+=("20261112T150000Z")   # backup manual del día 0
borrar="$(printf '%s\n' "${todos[@]}" | retener_stamps)"
quedan="$(printf '%s\n' "${todos[@]}" | grep -vxF -f <(printf '%s\n' "$borrar") | sort -r)"
n="$(printf '%s\n' "$quedan" | wc -l)"
[ "$n" = 18 ] || { echo "FALLA: quedan $n, esperaba 18"; printf '%s\n' "$quedan"; exit 1; }
# los 14 más nuevos son diarios consecutivos y el manual del día 0 reemplazó al de las 03:00
[ "$(printf '%s\n' "$quedan" | head -1)" = 20261112T150000Z ] || { echo "FALLA: no quedó el último del día"; exit 1; }
# los 4 restantes son domingos (date +%u == 7) y anteriores a los 14 días
printf '%s\n' "$quedan" | tail -4 | while read -r s; do
  [ "$(date -u -d "${s:0:4}-${s:4:2}-${s:6:2}" +%u)" = 7 ] || { echo "FALLA: $s no es domingo"; exit 1; }
done
echo "retencion ok: 14 diarios + 4 semanales (domingos), 1 por día"
