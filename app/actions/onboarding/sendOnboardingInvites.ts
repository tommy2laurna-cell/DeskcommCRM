"use server";

/**
 * Server Action: bulk-invite teammates from the onboarding wizard.
 *
 * Reuses the canonical invite token + email template (EPIC-09) directly so
 * we don't pay the cost of a self-call to the API route. Failures to send
 * email do NOT block onboarding progression.
 */
import { redirect } from "next/navigation";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitirConvite } from "@/lib/team/convites";
import { inviteOnboardingSchema } from "@/lib/schemas/onboarding";
import {
  requireOnboardingCtx,
  loadOnboardingState,
  patchOnboardingState,
  OnboardingError,
} from "./_shared";

type PapelHumano = "viewer" | "agent" | "manager" | "admin";

export type SendInvitesResult =
  | {
      ok: true;
      sent: number;
      failed: number;
      /** Convites cujo email NÃO saiu (ex.: Resend não configurado) — o link
       * de aceite é devolvido para o admin enviar manualmente. */
      undelivered?: { email: string; accept_url: string }[];
    }
  | { ok: false; error: "auth_required" | "no_active_org" | "forbidden" | "invalid_input"; details?: unknown };

interface InvitePayload {
  // Convite é para PESSOA: só papel humano. `ai_operator` não entra aqui de
  // propósito — é papel de token de agente, ninguém o recebe por e-mail.
  invitations: { email: string; role: PapelHumano }[];
  skip?: boolean;
}

export async function sendOnboardingInvites(payload: InvitePayload): Promise<SendInvitesResult> {
  let ctx;
  try {
    ctx = await requireOnboardingCtx();
  } catch (err) {
    if (err instanceof OnboardingError) return { ok: false, error: err.code as never };
    throw err;
  }

  // Pasado el onboarding, las invitaciones van por la pantalla de Equipo.
  const { onboardedAt } = await loadOnboardingState(ctx.orgId);
  if (onboardedAt) return { ok: false, error: "forbidden" };

  if (payload.skip) {
    await patchOnboardingState(ctx.orgId, { team: { invites_sent: 0, skipped: true } });
    await audit({
      action: "onboarding.team_invited",
      actorUserId: ctx.userId,
      organizationId: ctx.orgId,
      metadata: { skipped: true, count: 0 },
    });
    redirect("/onboarding");
  }

  let input;
  try {
    input = inviteOnboardingSchema.parse(payload);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return { ok: false, error: "invalid_input", details: err.flatten() };
    }
    throw err;
  }

  // Cada convite pasa por `emitirConvite`: firma el token, manda el mail,
  // audita `member.invited` y deja la fila en `team_invites` (revocable).
  const admin = createAdminClient();
  const requestId = `onboarding-${ctx.orgId}`;

  let sent = 0;
  let failed = 0;
  const undelivered: { email: string; accept_url: string }[] = [];
  for (const inv of input.invitations) {
    const r = await emitirConvite(admin, {
      organizationId: ctx.orgId,
      orgName: ctx.orgName,
      email: inv.email,
      role: inv.role,
      inviterId: ctx.userId,
      inviterName: ctx.fullName ?? ctx.email ?? "Um colega",
      requestId,
    });
    if (r.email_dispatched) sent += 1;
    else {
      failed += 1;
      undelivered.push({ email: r.convite.email, accept_url: r.accept_url });
    }
  }

  await patchOnboardingState(ctx.orgId, {
    team: { invites_sent: sent + failed, skipped: false },
  });
  await audit({
    action: "onboarding.team_invited",
    actorUserId: ctx.userId,
    organizationId: ctx.orgId,
    metadata: { count: sent + failed, sent, failed },
  });

  // Email falhou (ex.: VPS sem RESEND_API_KEY): NÃO redireciona em silêncio —
  // devolve os links de aceite pro admin enviar manualmente (mesmo contrato do
  // fallback de /app/team/invite). Redirect só no caminho 100% entregue.
  if (failed > 0) {
    return { ok: true, sent, failed, undelivered };
  }

  redirect("/onboarding");
}
