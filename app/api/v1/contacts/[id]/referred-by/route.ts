/**
 * GET   /api/v1/contacts/{id}/referred-by — quién recomendó a este contacto.
 * PATCH /api/v1/contacts/{id}/referred-by — { referred_by_contact_id: uuid | null }
 *
 * Ruta aparte para no tocar el handler de 30K del contacto. El recomendador debe
 * ser OTRO contacto de la MISMA organización: la FK sola no lo garantiza.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ referred_by_contact_id: z.string().uuid().nullable() });

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  const authz = await requireRole("viewer", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const { org } = authz;

  const supabase = await createClient();
  const { data: contato } = await supabase
    .from("contacts")
    .select("referred_by_contact_id")
    .eq("organization_id", org.orgId)
    .eq("id", id)
    .maybeSingle();
  if (!contato) return fail("not_found", "Contato não encontrado.", 404, { requestId });
  const refId = contato.referred_by_contact_id as string | null;
  if (!refId) return ok({ referred_by: null }, { requestId });

  const { data: ref } = await supabase
    .from("contacts")
    .select("id, name, display_name, phone_number")
    .eq("organization_id", org.orgId)
    .eq("id", refId)
    .maybeSingle();
  return ok(
    {
      referred_by: ref
        ? { id: ref.id, nombre: ref.name || ref.display_name || ref.phone_number || "" }
        : null,
    },
    { requestId },
  );
}

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  const authz = await requireRole("agent", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const refId = parsed.data.referred_by_contact_id;
  if (refId === id) {
    return fail("validation_failed", "Um contato não pode indicar a si mesmo.", 422, { requestId });
  }

  const supabase = await createClient();
  if (refId) {
    const { data: ref } = await supabase
      .from("contacts")
      .select("id")
      .eq("organization_id", org.orgId)
      .eq("id", refId)
      .maybeSingle();
    if (!ref) return fail("validation_failed", "Contato indicador inválido.", 422, { requestId });
  }

  const { data: atualizado, error } = await supabase
    .from("contacts")
    .update({ referred_by_contact_id: refId })
    .eq("organization_id", org.orgId)
    .eq("id", id)
    .select("id");
  if (error) return fail("internal_error", "Erro ao salvar indicação.", 500, { requestId });
  if (!atualizado?.length) return fail("not_found", "Contato não encontrado.", 404, { requestId });

  void audit({
    action: "contact.referred_by_changed",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "contact",
    resourceId: id,
    requestId,
    metadata: { referred_by_contact_id: refId },
  });
  return ok({ referred_by_contact_id: refId }, { requestId });
}
