#!/usr/bin/env bash
# LRN — arma el entregable del cliente desde HEAD con `git archive`.
# Uso:  scripts/lrn/empaquetar-entregable.sh [salida]     (default: $TMPDIR/lrn-entregable, fuera de OneDrive)
#       scripts/lrn/empaquetar-entregable.sh --escanear <carpeta>   (solo el escaneo de secretos)
# No modifica el repo. Nunca imprime valores: solo archivo:línea y nombre del patrón.
set -euo pipefail

# Archivos con falsos positivos revisados a mano (2026-10-12): valores de prueba, no credenciales.
# Archivo EXACTO, nunca carpeta: un secreto real en cualquier otro archivo sigue cortando el empaquetado.
#  - tests/unit/credenciais-ia-*.test.ts(x), llm-calls-registra-falha.test.ts: "sk-ant-…"/"CHAVE_SENTINELA" de fixtures
#  - lib/audit/service-role-configured.test.ts: JWT sintético (firma abcdef…)
#  - tests/sonda-radar-isolamento-orgs.ts: llave pública de demo de Supabase local (iss=supabase-demo)
#  - docs/specs/08-…, hostgator-setup-kit/test-validators.sh: valores "local…"/"segredo…" de ejemplo
PERMITIDOS='tests/unit/credenciais-ia-editar-na-tela\.test\.tsx|tests/unit/credenciais-ia-rotacao\.test\.ts|tests/unit/llm-calls-registra-falha\.test\.ts|lib/audit/service-role-configured\.test\.ts|tests/sonda-radar-isolamento-orgs\.ts|docs/specs/08-spec-deploy-observability\.md|hostgator-setup-kit/test-validators\.sh'

# Patrones de secretos (ERE). El valor nunca se imprime.
escanear() {
  local dir="$1" fallos=0 nombre patron out
  local -a PATRONES=(
    'sk-ant|sk-ant-[A-Za-z0-9_-]{20,}'
    'sk-|sk-[A-Za-z0-9_-]{32,}'
    'jwt|eyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'
    'clave-privada|-----BEGIN [A-Z ]*PRIVATE KEY-----'
    'aws|AKIA[0-9A-Z]{16}'
    'github|gh[pousr]_[A-Za-z0-9]{36,}'
    'slack|xox[abprs]-[A-Za-z0-9-]{20,}'
    # VAR_KEY / _SECRET / _TOKEN / _PASSWORD = valor largo literal (no ${...}, no process.env, no placeholder)
    'var-secreta|[A-Za-z0-9_]*(KEY|SECRET|TOKEN|PASSWORD)[A-Za-z0-9_]*[ ]*[=:][ ]*["'"'"']?[A-Za-z0-9+/_=-]{24,}["'"'"']?[ ]*$'
  )
  for p in "${PATRONES[@]}"; do
    nombre="${p%%|*}"; patron="${p#*|}"
    # -I ignora binarios. Se filtran placeholders obvios y se corta a archivo:línea (sin el valor).
    out=$(grep -rInE --exclude-dir=.git -e "$patron" "$dir" 2>/dev/null \
      | grep -viE 'your[-_]|changeme|placeholder|example|xxxx|<[a-z_-]+>|\$\{|process\.env|dummy|fake|test[-_]?(key|token|secret)|redacted' \
      | cut -d: -f1,2 | grep -vE "^$dir/($PERMITIDOS):" || true)
    if [ -n "$out" ]; then
      echo "SECRETO ($nombre):" >&2
      echo "$out" | sed "s#^$dir/#  #" | head -20 >&2
      fallos=1
    fi
  done
  return $fallos
}

# .env* solo permitidos si terminan en .example
verificar_envs() {
  local dir="$1" malos
  malos=$(find "$dir" -name '.env*' -type f ! -name '*.example' || true)
  if [ -n "$malos" ]; then
    echo "ENV FUERA DE LOS EJEMPLOS:" >&2; echo "$malos" | sed "s#^$dir/#  #" >&2
    return 1
  fi
}

if [ "${1:-}" = "--escanear" ]; then
  escanear "${2:?falta carpeta}"; verificar_envs "$2"; echo "OK: sin secretos ni .env"; exit 0
fi

cd "$(git rev-parse --show-toplevel)"
SALIDA="${1:-${TMPDIR:-/tmp}/lrn-entregable}"
command -v cygpath >/dev/null && SALIDA="$(cygpath -u "$SALIDA")"   # Git Bash: tar toma "C:\..." como host remoto
mkdir -p "$(dirname "$SALIDA")"
case "$(cd "$(dirname "$SALIDA")" && pwd)/" in *OneDrive*) echo "AVISO: la salida está en OneDrive; usá una ruta fuera del vault para entregables con datos de cliente." >&2;; esac
[ -z "$(git status --porcelain)" ] || echo "AVISO: hay cambios sin commitear; el entregable sale de HEAD ($(git rev-parse --short HEAD)), no del árbol de trabajo." >&2

# Exclusiones (solo del entregable, el repo no se toca). Ancladas a la raíz salvo los .env.
EXCLUIR=(
  # .env*: git archive solo trae lo versionado, pero se excluye igual por si alguien versionó uno por error
  ':(exclude,glob).env' ':(exclude,glob).env.*' ':(exclude,glob)**/.env' ':(exclude,glob)**/.env.*'
  # Carpetas internas del autor
  ':(exclude,glob)HANDOFF*.md' ':(exclude).specs' ':(exclude)plan' ':(exclude)tasks'
  ':(exclude)triagem' ':(exclude)loop' ':(exclude)evidence' ':(exclude)experiments'
  ':(exclude).claude' ':(exclude).agents' ':(exclude).codex' ':(exclude).cursor'
  # Criterio LRN
  ':(exclude).changes'                 # fragmentos de changelog del autor; el resultado ya está en CHANGELOG.md
  ':(exclude)RELATORIO-W1-GATILHOS.md' # reporte interno de trabajo del autor
  ':(exclude).github'                  # CI/dependabot/plantillas del repo del autor; el cliente no publica ahí
  ':(exclude).mailmap'                 # mapeo de autores de git, irrelevante sin historial
  ':(exclude)scripts/lrn'              # herramientas internas de LRN (este script)
  ':(exclude)LRN-ENTREGABLE.md'        # doc interna de LRN
)
rm -rf "$SALIDA" "$SALIDA.tar.gz"; mkdir -p "$SALIDA"
trap 'rm -rf "$SALIDA" "$SALIDA.tar.gz"' ERR   # un entregable que falló no queda a medio armar

git archive --format=tar HEAD -- . "${EXCLUIR[@]}" | tar -x -C "$SALIDA"
# Los .example vuelven a entrar (el exclude de .env.* los sacó)
git archive --format=tar HEAD -- ':(glob).env*.example' ':(glob)**/.env*.example' | tar -x -C "$SALIDA"

escanear "$SALIDA"
verificar_envs "$SALIDA"

tar -czf "$SALIDA.tar.gz" -C "$SALIDA" .
echo "OK: $(find "$SALIDA" -type f | wc -l) archivos desde $(git rev-parse --short HEAD)"
echo "Carpeta: $SALIDA"
echo "Paquete: $SALIDA.tar.gz"
