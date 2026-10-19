# LRN — Entregable de DeskcommCRM

Cómo se arma lo que se le entrega al cliente sin que salga ninguna clave ni carpeta interna del autor.

## Cómo correrlo

```bash
bash scripts/lrn/empaquetar-entregable.sh [salida]               # default: $TMPDIR/lrn-entregable (+ .tar.gz)
bash scripts/lrn/empaquetar-entregable.sh --escanear <carpeta>   # solo el escaneo de secretos
```

- Sale de **HEAD** con `git archive`: solo archivos versionados. Lo que no está commiteado no entra (el script avisa si hay cambios sin commitear).
- **Salida fuera de OneDrive** (el script avisa si no). El paquete de un cliente no debe sincronizarse a la nube.
- No modifica ni borra nada del repo. Si el escaneo falla, borra el entregable a medio armar y sale con error.
- Tarda ~1 min en OneDrive (el escaneo recorre ~3900 archivos).

## Qué entra
Todo lo versionado menos las exclusiones de abajo, más `.env.example` y `.env.hostgator.example` (solo placeholders). `LICENSE` y el copyright de Rafael Melgaço **entran siempre** (MIT).

## Qué no entra y por qué

| Exclusión | Motivo |
|---|---|
| `.env`, `.env.*` (salvo `*.example`) | Claves reales. `.gitignore` ya los deja fuera de git; se excluyen de nuevo por si alguien versionó uno. |
| `HANDOFF*.md`, `RELATORIO-W1-GATILHOS.md` | Notas de traspaso entre sesiones del autor; reportes internos. |
| `.specs`, `plan`, `tasks`, `triagem`, `loop` | Planificación y bucle de trabajo del autor. |
| `evidence`, `experiments` | Capturas y pruebas de trabajo del autor; no sirven para operar. |
| `.claude`, `.agents`, `.codex`, `.cursor` | Configuración de agentes de IA del autor. |
| `.changes` | Fragmentos de changelog pendientes; el resultado ya está en `CHANGELOG.md`. |
| `.github` | CI, dependabot y plantillas del repo del autor; el cliente no publica ahí. |
| `.mailmap` | Mapeo de autores de git, sin sentido sin historial. |
| `scripts/lrn`, `LRN-ENTREGABLE.md` | Herramientas internas de LRN. |

**Deliberadamente NO excluido:** `docs/`, `tests/`, `hostgator-setup-kit/` (lo usan install.sh/update.sh/tests), `supabase/`, `CLAUDE.md`/`AGENTS.md`. Se puede recortar `docs/` más adelante, pero hoy `CLAUDE.md` y los tests apuntan a él.

## Controles que cortan el empaquetado
1. **Escaneo de secretos** (muestra `archivo:línea` y nombre del patrón, nunca el valor): `sk-ant-…`, `sk-…`, JWT `eyJ….eyJ….…`, claves privadas PEM, AWS, GitHub, Slack, y variables `*_KEY/_SECRET/_TOKEN/_PASSWORD` con valor literal largo.
2. **Chequeo de `.env*`:** cualquier `.env*` que no termine en `.example` aborta.

Falsos positivos conocidos (fixtures de test y ejemplos de docs, revisados a mano el 2026-10-12) están en `PERMITIDOS` del script, **por archivo exacto**. Un archivo nuevo con un hallazgo corta el empaquetado hasta revisarlo.

Prueba del 2026-10-12: con `LRN_CANARY_123` en `.env.local`, el resultado (carpeta y tar.gz) tiene 0 apariciones; un `sk-…` falso y un `.env.production` suelto hacen fallar el escaneo (exit 1). Resultado limpio: 3922 archivos desde `8ad4e25`.

## Claves reales: no viven en el vault
El vault está en **OneDrive**: cualquier clave real que se guarde acá (incluido `.env.local`) se sincroniza a la nube y a todos los dispositivos con la cuenta. En el vault, solo placeholders.

Dónde guardar las claves reales de cada cliente, de más a menos recomendado:
1. **Gestor de contraseñas** (Bitwarden/1Password) con una bóveda o colección por cliente.
2. **Directo en la VPS del cliente** (`.env` con permisos 600). Es una instalación por cliente: el `.env` de producción nace y vive ahí, LRN no necesita tenerlo.
3. **Desarrollo local:** `.env.local` en una carpeta fuera de OneDrive (p. ej. `C:\Users\tommy\secretos\<cliente>\`), o mover el proyecto fuera de OneDrive.

Si una clave real ya estuvo en el vault: rotarla en el proveedor. Borrar el archivo no la saca del historial de versiones de OneDrive.

## Marca del cliente (qué se configura y qué no)
El nombre "DeskcommCRM" aparece solo si no se configura la marca. Por instalación, antes de entregar:
- `APP_NAME`, `APP_LOGO_URL`, `APP_ACCENT_HEX` en el `.env` del cliente, o desde la pantalla `/admin/marca` (el banco manda sobre el `.env`). Cubre login, títulos, manifest/PWA, ícono, correos y emisor del MFA.
- El instalador ofrece "DeskcommCRM" como valor por defecto de `APP_NAME` (`hostgator-setup-kit/install.sh:1261`): no apretar Enter, escribir el nombre del cliente.

`ACERCA.md` (atribución MIT) entra siempre al entregable; `LICENSE` no se toca.

Pendientes de marca que la configuración no resuelve (no se editó código): ver la sección del Registro en `04-CRM-LRN/03-Deskcomm/ESTADO.md`.
