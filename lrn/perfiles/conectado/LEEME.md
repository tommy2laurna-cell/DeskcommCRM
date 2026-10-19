# Perfil CONECTADO

CRM + WhatsApp (WAHA o Meta Cloud) + IA + webhooks/API + Resend.
Diseño completo: `04-CRM-LRN/03-Deskcomm/PERFILES.md`.

## Qué trae este perfil

| Archivo | Para qué |
|---|---|
| `.env.cliente.example` | Las variables que se completan por cliente. El resto lo genera `install.sh` |
| `LEEME.md` | Este archivo |

**No hay `docker-compose` de override.** El conectado usa el stack estándar de
`docker-compose.prod.yml` (app, worker, waha, redis, srh, scheduler, más caddy).
No hay nada que parchar.

## Instalación

1. Completar `CHECKLIST-INSTALACION-CLIENTE.md` (vive en `04-CRM-LRN/03-Deskcomm/`).
2. En la VPS, desde la raíz de la instalación:
   ```bash
   cp lrn/perfiles/conectado/.env.cliente.example .env
   # completar los campos [POR CLIENTE]
   export SUPABASE_ACCESS_TOKEN=sbp_...     # no se guarda en el .env
   bash hostgator-setup-kit/install.sh      # modo interactivo, sin --yes
   ```
3. Cuando termine, conectar el canal y la IA desde la interfaz (ver abajo).

No usar `--yes` con el `.env` copiado del ejemplo: instala por el canal móvil
`stable` y no pregunta lo que falta (ver `hostgator-setup-kit/CLAUDE.md`).

## Después de instalar

- **Canal:** Conexiones → QR (WAHA) o Admin → API Oficial (Meta).
  El QR tiene riesgo de baneo del número: está declarado en la ENTREGA y se
  ofrece la API oficial de Meta.
- **IA:** si no se cargó clave en el `.env`, IA → Credenciales.
- **Webhooks / n8n:** token en Ajustes → API tokens y webhook en `/app/webhooks`.

## Recursos

VPS de **4 GB** (el instalador avisa por debajo de 3,5 GB) más swap. Calcular
~150 MB extra por cada número conectado. Con Supabase en la nube no suma RAM.
Sin medir en ejecución: ver `ESTADO.md`.

## Riesgos que hay que decirle al cliente

- Baneo del número con WAHA (QR).
- Las imágenes `ghcr.io/melgarafael/*` son del upstream y todavía no están
  fijadas por versión (pendiente en `ESTADO.md`).
