import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET   /api/v1/settings/reviews — config del pedido de reseña (manager+).
 * PATCH /api/v1/settings/reviews — la guarda en organizations.settings.reviews.
 *
 * La escritura va por el admin client por la misma razón que `settings/routing`:
 * la única policy de escritura de `organizations` es de platform admin, y por el
 * client de sesión el UPDATE casaría 0 filas respondiendo éxito. El gate es el
 * rol resuelto por `requireRole` y el filtro por organización es explícito.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { validateRequest } from "@/lib/schemas";
import { reviewsSettingsLeituraSchema, reviewsSettingsSchema } from "@/lib/schemas/settings";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "settings_reviews" });
  if (!authz.ok) return authz.response;

  const { data, error } = await createAdminClient()
    .from("organizations")
    .select("settings")
    .eq("id", authz.org.orgId)
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });
  const settings = (data?.settings as Record<string, unknown> | null) ?? {};
  return ok(reviewsSettingsLeituraSchema.parse(settings.reviews ?? {}), { requestId });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "settings_reviews" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;

  let input;
  try {
    input = await validateRequest(reviewsSettingsSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const admin = createAdminClient();
  const { data: row, error: readErr } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", org.orgId)
    .maybeSingle();
  if (readErr) return fail("internal_error", readErr.message, 500, { requestId });

  const current = (row?.settings as Record<string, unknown> | null) ?? {};
  const { error: updErr } = await admin
    .from("organizations")
    .update({ settings: { ...current, reviews: input } })
    .eq("id", org.orgId);
  if (updErr) return fail("internal_error", updErr.message, 500, { requestId });

  void audit({
    action: "reviews.config_changed",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "organization",
    resourceId: org.orgId,
    requestId,
    metadata: { dias_despues: input.dias_despues, tiene_link: input.google_review_url !== "" },
  });
  return ok(input, { requestId });
}
