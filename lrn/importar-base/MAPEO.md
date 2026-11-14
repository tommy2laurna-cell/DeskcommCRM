# Mapeo CRM Base → CRM Conectado

Script: `lrn/scripts/importar-base.ts`. Origen: la copia `.sqlite` del Base (esquema 0.1.1, migraciones 0001 y 0002).
Idempotencia: cada fila lleva el id del Base (`id_externo`). Nada se descarta en silencio: lo que no tiene lugar va a una nota del contacto o al informe (`no-importado.json`).

| Base | Conectado | Cómo se reconoce en la 2.ª corrida |
|---|---|---|
| `embudo.nombre/orden/activo` | `crm_pipelines` (name, position, is_archived); slug `base-<nombre>`; `is_default` solo si la org no tiene uno | (org, slug) |
| `etapa.nombre/orden/color/activa` | `crm_stages` (name, position, color, is_archived) | (embudo, slug) |
| `etapa.dias_estancada` | `expected_duration_hours` = días × 24 | — |
| `etapa.cierre` ganada/perdida | `is_won` / `is_lost`. El Conectado admite una de cada una por embudo: la 2.ª ganada se **fusiona** en la 1.ª y su nombre queda en `source_metadata.base_etapa` de cada oportunidad (+ aviso) | — |
| `cuenta.*` (nombre, CUIT, tel., email, notas, extra) | **Nota del contacto** (el Conectado no tiene cuentas) | headline `Base c<id> · datos del CRM Base` |
| `contacto.nombre/telefono/email/creado` | `contacts` name, phone_number (E.164 con `normalizePhoneBR`), email, created_at; `source = importar-base`, `source_metadata.id_externo = c<id>`. Si ya existe uno con ese teléfono o email se reutiliza, sin pisarlo (aviso) | `source_metadata->>id_externo`, luego teléfono, luego email |
| `contacto.telefono` que no se normaliza | **Nota del contacto** («Teléfono (no se pudo normalizar)») | — |
| `contacto.cumple` (`MM-DD`, sin año) | **Nota del contacto** (`birthdate` pide año) | — |
| `contacto.notas`, `contacto.extra` (campos propios) | **Nota del contacto** (una línea por campo) | — |
| `contacto_etiqueta` → `etiqueta.nombre` | `contacts.tags` (minúsculas, 40 caracteres, como `normalizarTag`) | — |
| `etiqueta.tono` (color) | Sin lugar: va a `no-importado.json` | — |
| `contacto.borrado` | No se importa (informe). Excepción: borrado pero con oportunidades vivas, se importa (aviso) | — |
| `oportunidad.titulo/monto_centavos/moneda` | `crm_leads` title, value_cents, currency (si no es ISO, queda en `source_metadata.base_moneda`) | `(org, source = importar-base, external_id = o<id>)` |
| `oportunidad.etapa_id`, `contacto_id` | stage_id + pipeline_id, contact_id | — |
| `oportunidad.cierre` por etapa, `motivo_perdida`, `cerrada` | status won/lost/open, lost_reason, closed_at | — |
| `oportunidad.extra` | `crm_leads.custom_fields` | — |
| `oportunidad_etiqueta` | `crm_leads.tags` | — |
| `oportunidad.creada` | created_at | — |
| `oportunidad.en_etapa_desde`, `actualizada` | `source_metadata.base_en_etapa_desde`, `base_actualizada` | — |
| `oportunidad.borrada` | No se importa (informe) | — |
| `toque` tipo nota/llamada/whatsapp/mail/reunion | `lead_notes` (headline `Base t<id> · <tipo> · <texto>`, body = texto + oportunidad de origen) | (org, contacto, headline) |
| `toque` tipo tarea (`vence`, `hecho`) | `crm_tasks` (title, due_date a las 12:00 UTC, status done/pending, lead y contacto); marcador `base:t<id>` en `description` | (org, description) |
| `lista` (filtros guardados) | Sin equivalente: `no-importado.json` | — |
| `ajuste` | Es configuración de la app de escritorio: no se importa | — |
| `marca.json` negocio, colores.acento | `platform_branding.app_name`, `accent_hex` (lo que muestra /app/settings/marca). Solo llena lo vacío; `--pisar-marca` reemplaza | si ya hay valor, no se toca |
| `marca.json` logo | Storage `brand-logos` (PNG/JPG ≤ 512 KB) → `platform_branding.logo_path`. Mismo criterio | si ya hay `logo_path`, no se sube |
| `marca.json` palabras, campos_extra, motivos_perdida, colores.primario | No se aplican (se configuran en el Conectado); el informe lo dice | — |

Qué hace el Conectado al insertar un lead (trigger `trg_emit_event_on_lead_change`): emite el evento de lead nuevo. Si el cliente ya tiene automatizaciones enganchadas a ese evento, **corren con cada oportunidad importada**: revisarlo antes del modo real.
