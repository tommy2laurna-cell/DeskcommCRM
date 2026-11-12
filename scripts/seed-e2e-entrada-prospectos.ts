/**
 * Seed E2E de la entrada de prospectos: un token de API de la org de test con
 * los scopes que le da quien arma la automatización de n8n (`mcp:read` para
 * poder consultar, `mcp:write` para escribir). Rol por defecto: agent.
 *
 * Depende de que `seed-e2e-credentials.ts` ya haya corrido (crea la org y sus
 * funnels). Escribe el plaintext en `.e2e-entrada-prospectos.json` (gitignored).
 *
 * Run: npx tsx scripts/seed-e2e-entrada-prospectos.ts
 */
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { anunciarDestino, credenciaisSupabaseDeTeste } from "./lib/env-de-teste";

const credenciales = credenciaisSupabaseDeTeste();
anunciarDestino("seed-e2e-entrada-prospectos", credenciales);

const admin = createClient(credenciales.url, credenciales.serviceRole, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const NOMBRE = "e2e-entrada-prospectos";
const ORG_SLUG = "e2e-test-org";

async function main(): Promise<void> {
  const { data: org, error: orgErr } = await admin
    .from("organizations")
    .select("id")
    .eq("slug", ORG_SLUG)
    .maybeSingle();
  if (orgErr) throw new Error(orgErr.message);
  if (!org) throw new Error(`org "${ORG_SLUG}" no existe — corré scripts/seed-e2e-credentials.ts antes`);
  const orgId = (org as { id: string }).id;

  const { data: dueno, error: duenoErr } = await admin
    .from("user_organizations")
    .select("user_id")
    .eq("organization_id", orgId)
    .eq("role", "admin")
    .is("revoked_at", null)
    .limit(1)
    .maybeSingle();
  if (duenoErr) throw new Error(duenoErr.message);
  if (!dueno) throw new Error("no hay admin activo en la org de E2E");

  const { data: funil, error: funilErr } = await admin
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", orgId)
    .eq("is_default", true)
    .eq("is_archived", false)
    .maybeSingle();
  if (funilErr) throw new Error(funilErr.message);
  if (!funil) throw new Error("la org de E2E no tiene embudo is_default: el prospecto no tendría dónde entrar");

  const prefix = `dsk_e2epr_${randomBytes(3).toString("hex")}`;
  const plaintext = `${prefix}_${randomBytes(32).toString("base64url")}`;
  const hash = createHash("sha256").update(plaintext).digest();

  const { data: token, error } = await admin
    .from("api_tokens")
    .insert({
      organization_id: orgId,
      created_by: (dueno as { user_id: string }).user_id,
      name: NOMBRE,
      prefix,
      token_hash: `\\x${hash.toString("hex")}`,
      scopes: ["mcp:read", "mcp:write"],
      expires_at: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
    })
    .select("id")
    .single();
  if (error || !token) throw new Error(error?.message ?? "insert del token falló");

  fs.writeFileSync(
    path.join(process.cwd(), ".e2e-entrada-prospectos.json"),
    JSON.stringify({ organization_id: orgId, token_id: (token as { id: string }).id, bearer: plaintext }, null, 2),
  );
  console.info(`token de entrada de prospectos emitido para la org ${orgId}`);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
