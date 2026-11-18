/**
 * Consulta `.in(coluna, ids)` em lotes.
 *
 * O supabase-js manda o filtro `in` na URL: com ~300 uuids (36 caracteres cada)
 * a URI passa de 11 KB e o proxy/PostgREST responde "URI too long". É o que
 * quebrava o tablero com 300 leads. Lotes de 100 ficam em ~4 KB.
 *
 * Só serve para filtros que somam por união (cada lote devolve linhas
 * independentes). Quem depende de ordem global reordena o resultado.
 */
export const TAMANHO_LOTE_IDS = 100;

export interface RespostaLote<T> {
  data: T[] | null;
  error: { message: string } | null;
}

export async function emLotes<T>(
  ids: readonly string[],
  consulta: (lote: string[]) => PromiseLike<RespostaLote<T>>,
  tamanho: number = TAMANHO_LOTE_IDS,
): Promise<{ data: T[]; error: { message: string } | null }> {
  const lotes: string[][] = [];
  for (let i = 0; i < ids.length; i += tamanho) lotes.push(ids.slice(i, i + tamanho));

  const respostas = await Promise.all(lotes.map((lote) => consulta(lote)));
  const erro = respostas.find((r) => r.error)?.error ?? null;
  if (erro) return { data: [], error: erro };
  return { data: respostas.flatMap((r) => r.data ?? []), error: null };
}
