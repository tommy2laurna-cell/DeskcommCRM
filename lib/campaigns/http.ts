/**
 * Cola común de las rutas de listas y campañas: creación con `Idempotency-Key`
 * (mismo contrato que `message-templates`) y el cliente sin tipos de tabla.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { chaveDaRequisicao, comIdempotencia } from "@/lib/api/idempotency";
import { fail, ok } from "@/lib/api/wrappers";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import { createClient } from "@/lib/supabase/server";

/** Las tablas nuevas aún no están en `database.types.ts`: cliente sin tipos de tabla. */
export async function clienteDeUsuario(): Promise<SupabaseClient> {
  return (await createClient()) as unknown as SupabaseClient;
}

export async function crearIdempotente<T>(input: {
  req: NextRequest;
  db: SupabaseClient;
  organizationId: string;
  endpoint: string;
  corpo: unknown;
  requestId: string;
  idioma: Idioma;
  /** Lanza en falla: así no se graba recibo de una creación que no ocurrió. */
  crear: () => Promise<T>;
}): Promise<Response> {
  const t = (texto: string) => traduzir(texto, input.idioma);
  const { requestId } = input;
  const chave = chaveDaRequisicao(input.req);
  if (chave !== null && !z.string().uuid().safeParse(chave).success) {
    return fail("validation_error", "Idempotency-Key deve ser UUID", 400, { requestId });
  }
  try {
    if (chave === null) return ok(await input.crear(), { requestId, status: 201 });
    const desfecho = await comIdempotencia({
      db: input.db,
      organizationId: input.organizationId,
      endpoint: input.endpoint,
      chave,
      corpo: input.corpo,
      executar: async () => ({ resposta: await input.crear(), status: 201 }),
    });
    if (desfecho.tipo === "conflito") {
      return fail(
        "idempotency_conflict",
        t("Esta chave de idempotência já foi usada com outro conteúdo."),
        409,
        { requestId },
      );
    }
    return ok(desfecho.resposta, { requestId, status: 201 });
  } catch (err) {
    // 23505 = nombre repetido (índice único): es un 409 honesto, no un 500.
    if ((err as { code?: string }).code === "23505") {
      return fail("conflict", t("Já existe um registro com esse nome."), 409, { requestId });
    }
    return fail("internal_error", t("Erro ao criar."), 500, { requestId });
  }
}
