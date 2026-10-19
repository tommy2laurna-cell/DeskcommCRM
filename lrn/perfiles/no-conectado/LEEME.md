# Perfil NO CONECTADO

CRM (contactos, embudo, tareas, agenda, equipo) sin canal de WhatsApp, sin clave
de IA, sin webhooks y sin Resend. Diseño completo: `04-CRM-LRN/03-Deskcomm/PERFILES.md`.

## Qué trae este perfil

| Archivo | Para qué |
|---|---|
| `.env.cliente.example` | Las variables que se completan por cliente. El resto lo genera `install.sh` |
| `LEEME.md` | Este archivo |

## Sin override de docker-compose ni parche (opción A)

Se instala el **mismo stack que el conectado** y simplemente no se conecta nada.
WAHA queda corriendo sin sesiones. Es la opción recomendada en `PERFILES.md § 1`
porque no toca código del upstream.

La opción B (sacar `waha` del compose) **no se aplicó**. Si se aplicara solo el
override, el producto se rompe: `app` depende de `waha`, el health responde 503 y
`update.sh` sale con error. B exige el parche de 4 archivos de `PERFILES.md § 4`
(`lib/env.ts`, `install.sh`, `_common.sh` y el compose nuevo). Elegir B solo si
la medición de RAM de WAHA sin sesiones obliga a pasar de una VPS de 2 GB a 4 GB.

## Instalación

1. Completar `CHECKLIST-INSTALACION-CLIENTE.md` (vive en `04-CRM-LRN/03-Deskcomm/`).
2. En la VPS, desde la raíz de la instalación:
   ```bash
   cp lrn/perfiles/no-conectado/.env.cliente.example .env
   # completar los campos [POR CLIENTE]
   export SUPABASE_ACCESS_TOKEN=sbp_...     # no se guarda en el .env
   bash hostgator-setup-kit/install.sh      # modo interactivo, sin --yes
   ```
3. Durante el instalador, en las preguntas de IA y de OpenAI presionar Enter
   (quedan vacías).
4. En el onboarding de la interfaz, usar **Pular** en WhatsApp, IA y "Probar".

No usar `--yes` con el `.env` copiado del ejemplo (ver `hostgator-setup-kit/CLAUDE.md`).

## Cerrar la puerta del canal

En Equipo, definir la interfaz de cada miembro (preset `simplificada` o lista
`destinos`) y sacar Inbox, Conexiones, Plantillas y el grupo IA. Es solo
presentación, no bloquea rutas: un admin del cliente puede volver a mostrarlas y
conectar un WhatsApp por QR. Eso se cubre en el contrato, no con código.

## Pasar a conectado (sin reinstalar)

Ver `PERFILES.md § 5`. Resumen: agrandar la VPS a 4 GB, cargar clave de IA
(IA → Credenciales), conectar el canal (Conexiones), poner `RESEND_*` en el `.env`
y correr `bash hostgator-setup-kit/update.sh` (un restart no alcanza), y volver a
mostrar los menús ocultos.

## Recursos

VPS de **2 GB** con swap de 1–2 GB, **si** la medición de WAHA sin sesiones lo
confirma; si no, 4 GB. Sin medir todavía (`docker stats --no-stream`).

## Límite que hay que decirle al cliente

El mail de "olvidé mi contraseña" sale por el SMTP por defecto de Supabase, con un
límite bajo por hora. Para uso diario: Resend o SMTP propio en Supabase Auth.
