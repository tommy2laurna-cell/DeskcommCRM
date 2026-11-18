# Listas inteligentes y campañas

## Listas inteligentes (migración 0278)
Una lista guarda **filtros**, no personas: etiqueta, etapa, origen, puntaje (0–100, del negocio abierto), «sin contacto hace más de N días» (quien nunca tuvo actividad cuenta) y cumpleaños del mes. La membresía se recalcula en cada lectura con `fn_smart_list_contacts`; se pagina por `id` (`?despues=<uuid>&limite=50`), sin URLs largas. API: `/api/v1/smart-lists` (+ `/:id`, `/:id/contacts`). Pantalla: `/app/listas`.

## Campañas (migración 0279)
Un mensaje aprobado de Meta enviado a una lista, **solo por la API de Meta** (una sesión que no sea `meta_cloud` se rechaza). Flujo: borrador → vista previa → confirmar → el cron `cron/campaigns` envía de a lotes de 15 por minuto, con espaciamiento anti-ban y tope diario por sesión.

- Estados del destinatario: `pendiente`, `enviado`, `excluido_optout`, `excluido_sin_telefono`, `error`. `unique(campaign_id, contact_id)` vuelve idempotente el reintento (hasta 3 intentos por destinatario).
- El opt-out (`contacts.is_blocked` o `consent.marketing.declined_at`) se **revalúa justo antes de cada envío**.
- Marketing exige un botón de respuesta rápida de baja: sin él, confirmar devuelve «Los mensajes de marketing necesitan un botón de baja». El toque del botón llega como texto (`webhook.ts`), el detector de opt-out lo reconoce y `pos-entrada.ts` bloquea al contacto y registra `consent.marketing.declined_at`.
- `CAMPAIGNS_TRANSPORT=simulado` reemplaza solo la llamada a la Graph API por un id `sim:<teléfono>` (jornada de prueba). Vacío = Meta real.

## Costo estimado
No hay tarifa por defecto. El admin la carga en `organizations.settings.campaigns.tarifa` (`{marketing, utility, authentication?, moneda, fuente_url, vigente_desde}`, por `PUT /api/v1/campaigns/tarifa`). Con tarifa: costo = destinatarios efectivos × tarifa de la categoría, con la fuente a la vista. Sin tarifa: «Cargá la tarifa vigente de Meta para ver el costo» y ningún número.

Fuente oficial: https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing — las tarifas por país (Argentina incluida) están en las rate cards descargables de esa página, no en el HTML.
