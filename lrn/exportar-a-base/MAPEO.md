# Mapeo CRM Conectado → CRM Base

Script: `lrn/scripts/exportar-a-base.ts`. Destino: un `crm.db` en la última migración del Base (hoy 0004, 0.2.0), con las migraciones de `lrn/fixtures/base-migraciones` (copia exacta de `src-tauri/migrations` del Base: al sacar una versión nueva del Base se copia la migración nueva ahí).
Es el inverso de `lrn/importar-base/MAPEO.md`. Solo lee del Conectado. Idempotente: los ids del Base salen del orden de creación, así que dos corridas sobre los mismos datos dan el mismo contenido (`huella`). Nada se descarta en silencio: lo que no entra va a `no-exportado.csv`.

| Conectado | Base | Notas |
|---|---|---|
| `crm_pipelines` name/position/is_archived | `embudo` nombre/orden/activo | El «Ventas» que deja la 0002 se reemplaza. Nombre repetido → `Nombre (2)` + aviso |
| `crm_stages` name/position/color/is_archived | `etapa` nombre/orden/color/activa | Orden por embudo, luego posición. El nombre es único en todo el Base: si choca queda `nombre (Embudo)` + aviso |
| `crm_stages.expected_duration_hours` | `etapa.dias_estancada` | `ceil(horas / 24)`, mínimo 1; 7 si no había |
| `crm_stages.is_won` / `is_lost` | `etapa.cierre` ganada / perdida | |
| `contacts` name/display_name, phone_number, email | `contacto` nombre, telefono, email | Nombre: `display_name`, `name`, teléfono o email; «Sin nombre» como último recurso |
| `contacts.birthdate` | `contacto.nacimiento` (0004) | |
| `contacts.source` | `contacto.origen` (0003) | |
| `contacts.tags` | `etiqueta` + `contacto_etiqueta` | Únicas sin distinguir mayúsculas; tono por defecto |
| `contacts` fusionado (`is_merged_into`) | No viaja (CSV) | Sus oportunidades, notas y tareas pasan al contacto que quedó |
| `contacts` anonimizado | No viaja (CSV) | Irreversible: no hay datos que bajar |
| `contacts.is_blocked`, consentimientos, CPF | Sin lugar | El contacto viaja; el bloqueo queda en el CSV |
| `crm_leads` title/value_cents/currency | `oportunidad` titulo/monto_centavos/moneda | Monto negativo → sin monto + aviso. Moneda vacía → ARS |
| `crm_leads.stage_id` | `oportunidad.etapa_id` | Si el estado es won/lost y la etapa no cierra, pasa a la etapa de cierre de su embudo (aviso) |
| `crm_leads.lost_reason` | `oportunidad.motivo_perdida` | El Base lo exige en etapa perdida: sin motivo → «Sin motivo» |
| `crm_leads.closed_at` | `oportunidad.cerrada` | Solo en etapas de cierre |
| `crm_leads.custom_fields` | `oportunidad.extra` | |
| `crm_leads.tags` | `oportunidad_etiqueta` | |
| `crm_leads` sin contacto | Cuelga de `(Sin contacto)` | El Base exige contacto en cada oportunidad y toque. Se crea una sola vez y se avisa |
| `crm_leads.source_metadata.base_en_etapa_desde` | `oportunidad.en_etapa_desde` | Si no, la fecha de actualización |
| `lead_notes` headline `Base t<id> · <tipo> · …` | `toque` del mismo `tipo` | Deshace `importar-base`; la oportunidad vuelve por `(Oportunidad n.º N del Base.)` |
| `lead_notes` (otras) | `toque` tipo `nota` | `texto` = titular + cuerpo |
| `crm_tasks` | `toque` tipo `tarea` | `vence` = día de `due_date` (UTC); sin fecha → día de creación + aviso. `done` → `hecho`. El marcador `base:t<id>` de `description` no se exporta |
| `crm_tasks` cancelada | No viaja (CSV) | El Base no tiene tarea cancelada |
| `platform_branding` app_name, accent_hex, logo | `marca.json` + `logo.png` | `negocio`, `colores.acento`, etapas del embudo principal, motivos de pérdida y moneda más usada. Logo solo si es PNG. Sin nombre de marca no se genera |

Abierto: el archivo trae `_sqlx_migrations` con el checksum SHA-384 de cada migración, como lo deja la app, para que el Base no migre de cero. `--verificar <crm.db>` repite lo que hace `src-tauri/src/migraciones.rs` (checksums, `VERSION_FUTURA`, `quick_check`) más `integrity_check` y `foreign_key_check`. Es una reproducción en TypeScript: el runner real es Rust/sqlx y no corre en este CI.

El informe cuadra cada tabla: `origen = destino + lo que va al CSV` (con `(Sin contacto)` aparte). Si no cuadra, el script sale con error.
