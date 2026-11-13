/**
 * Jornada: lista inteligente -> campaña (transporte SIMULADO) -> el contacto con
 * `consent.marketing.declined_at` NO recibe; los demás sí.
 *
 * El transporte de Meta se simula con `CAMPAIGNS_TRANSPORT=simulado` en el
 * ENTORNO DE LA APP (no en este proceso): el cron marca el envío con un id
 * `sim:<teléfono>` en vez de llamar a la Graph API. Todo lo demás corre de
 * verdad — guardas, revaluación del opt-out, estados. NUNCA llama a Meta.
 *
 * Requiere la app ya servida con ese entorno, `.e2e-creds.json` y
 * SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_URL / INTERNAL_SECRET en el
 * ambiente de este proceso (la CI los exporta). Siembra con prefijo propio y
 * limpia al terminar.
 */
import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

import { lerCreds } from "./_login";

const URL_DB = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const CRON_SECRET = process.env.INTERNAL_CRON_SECRET || process.env.INTERNAL_SECRET || "";

const RUN = Date.now().toString().slice(-8);
const ETIQUETA = `journey-camp-${RUN}`;
const TEL = (n: number) => `+54911${RUN.slice(-4)}${String(n).padStart(4, "0")}`;
const SOLO_DIGITOS = (s: string) => s.replace(/\D/g, "");

test.describe.configure({ mode: "serial" });

test("la baja registrada excluye al contacto: sin recipient enviado y sin envío a su teléfono", async ({ request }) => {
  test.skip(!URL_DB || !SERVICE || !CRON_SECRET, "falta el ambiente de Supabase/cron");

  const org = lerCreds().org_id;
  const db = createClient(URL_DB, SERVICE, { auth: { persistSession: false } });

  // --- siembra -------------------------------------------------------------
  const contactos = [
    { phone_number: TEL(1), name: "Journey Uno", consent: undefined },
    { phone_number: TEL(2), name: "Journey Dos", consent: undefined },
    {
      phone_number: TEL(3),
      name: "Journey Baja",
      consent: { marketing: { granted_at: null, declined_at: new Date().toISOString(), source: "journey" } },
    },
  ];
  const { data: filas, error: errC } = await db
    .from("contacts")
    .insert(
      contactos.map((c) => ({
        organization_id: org,
        name: c.name,
        phone_number: c.phone_number,
        tags: [ETIQUETA],
        ...(c.consent ? { consent: c.consent } : {}),
      })),
    )
    .select("id, phone_number");
  expect(errC).toBeNull();
  const idBaja = filas!.find((f) => f.phone_number === TEL(3))!.id as string;

  const meta = `${RUN}000000`;
  const { data: sesion, error: errS } = await db
    .from("channel_sessions")
    .insert({
      organization_id: org,
      provider: "meta_cloud",
      meta_phone_number_id: meta,
      waha_session_name: `journey-meta-${RUN}`,
      status: "WORKING",
      display_name: `Journey Meta ${RUN}`,
    })
    .select("id")
    .single();
  expect(errS).toBeNull();

  const nombreMensaje = `journey_promo_${RUN}`;
  const { error: errT } = await db.from("meta_templates").insert({
    organization_id: org,
    waba_id: "journey",
    name: nombreMensaje,
    language: "es_AR",
    status: "APPROVED",
    category: "MARKETING",
    contract_hash: "journey",
    components: [
      { type: "BODY", text: "Hola, tenemos una promo para vos." },
      { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Baja" }] },
    ],
  });
  expect(errT).toBeNull();

  try {
    // --- lista inteligente por etiqueta -------------------------------------
    const lista = await request.post("/api/v1/smart-lists", {
      data: { name: `Journey ${RUN}`, filters: { etiquetas: [ETIQUETA] } },
    });
    expect(lista.status()).toBe(201);
    const listaId = (await lista.json()).data.id as string;

    const miembros = await request.get(`/api/v1/smart-lists/${listaId}/contacts?limite=50`);
    expect((await miembros.json()).data).toHaveLength(3);

    // --- campaña: borrador -> vista previa -> confirmar ---------------------
    const camp = await request.post("/api/v1/campaigns", {
      data: {
        name: `Campaña journey ${RUN}`,
        list_id: listaId,
        channel_session_id: sesion!.id,
        template_name: nombreMensaje,
        template_language: "es_AR",
      },
    });
    expect(camp.status()).toBe(201);
    const campId = (await camp.json()).data.id as string;

    const previa = (await (await request.get(`/api/v1/campaigns/${campId}/preview`)).json()).data;
    expect(previa.destinatarios).toMatchObject({ total: 3, efectivos: 2, excluidos_optout: 1 });
    // Sin tarifa cargada no hay cifra de costo.
    expect(previa.costo.disponible).toBe(false);

    const conf = await request.post(`/api/v1/campaigns/${campId}/confirm`, { data: {} });
    expect(conf.status()).toBe(200);

    // --- el cron envía (simulado), lote a lote ------------------------------
    for (let i = 0; i < 10; i++) {
      const r = await request.post("/api/v1/cron/campaigns", {
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      });
      expect(r.status()).toBe(200);
      const { data } = await db.from("campaigns").select("status").eq("id", campId).single();
      if (data?.status === "completada") break;
    }

    // --- aserciones ----------------------------------------------------------
    const { data: dest } = await db
      .from("campaign_recipients")
      .select("contact_id, status, external_id")
      .eq("campaign_id", campId);
    const baja = dest!.find((d) => d.contact_id === idBaja)!;
    expect(baja.status).toBe("excluido_optout");
    expect(baja.external_id).toBeNull();

    const enviados = dest!.filter((d) => d.status === "enviado");
    expect(enviados).toHaveLength(2);
    // Cero envíos al teléfono de la baja: ningún id simulado lo contiene.
    expect(dest!.some((d) => (d.external_id ?? "").includes(SOLO_DIGITOS(TEL(3))))).toBe(false);
    expect(enviados.map((d) => d.external_id).sort()).toEqual(
      [`sim:${SOLO_DIGITOS(TEL(1))}`, `sim:${SOLO_DIGITOS(TEL(2))}`].sort(),
    );

    const { data: final } = await db.from("campaigns").select("status, total_sent, total_excluded").eq("id", campId).single();
    expect(final).toMatchObject({ status: "completada", total_sent: 2, total_excluded: 1 });
  } finally {
    await db.from("campaigns").delete().eq("organization_id", org).like("name", `%${RUN}`);
    await db.from("smart_lists").delete().eq("organization_id", org).eq("name", `Journey ${RUN}`);
    await db.from("meta_templates").delete().eq("organization_id", org).eq("name", nombreMensaje);
    await db.from("channel_sessions").delete().eq("id", sesion!.id);
    await db.from("contacts").delete().eq("organization_id", org).contains("tags", [ETIQUETA]);
    void randomUUID;
  }
});
