import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn(async () => null) }));

import { createClient } from "@/lib/supabase/server";

const ORG = "11111111-1111-4111-8111-111111111111";
const PIPE = "22222222-2222-4222-8222-222222222222";
const STAGE = "33333333-3333-4333-8333-333333333333";
// PostgREST/proxy cortam por volta de 8 KB de URI; o filtro `in` vai na URL.
const LIMITE_URI = 8000;

const uuid = (prefixo: string, n: number) =>
  `${prefixo}${String(n).padStart(7, "0")}-0000-4000-8000-000000000000`;

type Row = Record<string, unknown>;

/** Tabela falsa: aplica eq/in e REPROVA como o proxy se a URI passar do limite. */
function banco(tabelas: Record<string, Row[]>) {
  const maiorIn = { n: 0 };
  const from = (tabela: string) => {
    const filtros: Array<(r: Row) => boolean> = [];
    let uriLen = 0;
    const q = {
      select: () => q,
      order: () => q,
      neq: (c: string, v: unknown) => (filtros.push((r) => r[c] !== v), q),
      eq: (c: string, v: unknown) => (filtros.push((r) => r[c] === v), q),
      not: () => q,
      in: (c: string, vs: string[]) => {
        uriLen += vs.join(",").length;
        maiorIn.n = Math.max(maiorIn.n, vs.length);
        filtros.push((r) => vs.includes(r[c] as string));
        return q;
      },
      maybeSingle: async () => ({
        data: (tabelas[tabela] ?? []).filter((r) => filtros.every((f) => f(r)))[0] ?? null,
        error: null,
      }),
      then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
        Promise.resolve(
          uriLen > LIMITE_URI
            ? { data: null, error: { message: "URI too long" } }
            : {
                data: (tabelas[tabela] ?? []).filter((r) => filtros.every((f) => f(r))),
                error: null,
              },
        ).then(ok, ko),
    };
    return q;
  };
  return {
    maiorIn,
    client: { auth: { getUser: async () => ({ data: { user: { id: "u" } }, error: null }) }, from },
  };
}

function leads(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: uuid("a", i),
    organization_id: ORG,
    pipeline_id: PIPE,
    stage_id: STAGE,
    contact_id: uuid("c", i),
    status: "open",
    position_in_stage: i,
    owner_kind: "human",
  }));
}

beforeEach(() => vi.clearAllMocks());

describe("GET /api/v1/pipelines/[id]/board com volume", () => {
  it.each([1, 300, 1000])(
    "com %i leads não monta URI com todos os ids: 200, todos os cards, com score e conversa",
    async (N) => {
      const db = banco({
        crm_pipelines: [{ id: PIPE, organization_id: ORG, is_default: true }],
        crm_stages: [{ id: STAGE, pipeline_id: PIPE, is_archived: false, position: 1 }],
        crm_leads: leads(N),
        crm_lead_scores: leads(N).map((l) => ({
          organization_id: ORG,
          lead_id: l.id,
          ai_probability: "0.5",
          ai_probability_reason: "r",
          ai_probability_band: "medium",
          ai_probability_evidence: { factors: [] },
          ai_probability_at: null,
        })),
        conversations: leads(N).flatMap((l, i) => [
          {
            id: uuid("d", i),
            organization_id: ORG,
            contact_id: l.contact_id,
            last_message_preview: "velha",
            last_message_at: "2026-01-01T00:00:00Z",
            unread_count_for_assignee: 0,
          },
          {
            id: uuid("e", i),
            organization_id: ORG,
            contact_id: l.contact_id,
            last_message_preview: "nova",
            last_message_at: "2026-02-01T00:00:00Z",
            unread_count_for_assignee: 2,
          },
        ]),
        lead_state: [],
      });
      vi.mocked(createClient).mockResolvedValue(db.client as never);

      const { GET } = await import("./route");
      const res = await GET({} as NextRequest, { params: Promise.resolve({ id: PIPE }) });
      const corpo = (await res.json()) as { data: { leads: Row[] } };

      expect(res.status).toBe(200);
      expect(corpo.data.leads).toHaveLength(N);
      expect(corpo.data.leads.every((l) => l.score)).toBe(true);
      // a conversa mais recente de cada contato, mesmo vinda de lotes distintos
      expect(
        corpo.data.leads.every((l) => (l.conversa as { preview: string }).preview === "nova"),
      ).toBe(true);
      expect(db.maiorIn.n).toBeLessThanOrEqual(100);
    },
  );
});
