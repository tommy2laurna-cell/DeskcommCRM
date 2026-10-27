/**
 * Nono dígito brasileiro: a mesma pessoa chega com 12 ou 13 dígitos.
 *
 * ─── O problema, medido contra a WABA real em 2026-07-29 ─────────────────────
 *   envio (funcionou)        5531998966398   13 dígitos
 *   `wa_id` do inbound        553198966398   12 dígitos, sem o nono
 *
 * Sem tratar, o contato que recebe e o que responde viram DOIS — conversa
 * partida, histórico fragmentado, e silencioso.
 *
 * ─── O que o CRM guarda e mostra ────────────────────────────────────────────
 * Celular BR é sempre a forma COM o nono (`+5532984793302`). É o que o
 * brasileiro espera ler e copiar. Fixo (local 2–5) e número de outro país
 * ficam como chegaram — inventar um 9 num fixo fundiria duas pessoas.
 *
 * ─── O que o WhatsApp/WAHA aceitam ──────────────────────────────────────────
 * O wa_id registrado pode omitir o 9. A busca usa as DUAS grafias
 * (`phoneLookupVariants`); o envio pergunta ao transporte (`check-exists`)
 * qual delas existe, em `lib/waha/resolve-contact-whatsapp-id.ts`. Não
 * adivinhar o formato de envio a partir do cadastro.
 */

/** Só dígitos, sem `+`. */
function digitsOf(raw: string): string {
  return raw.replace(/\D/g, "");
}

/**
 * Argentina: o celular é +54 9 <área><número> (forma do `wa_id` e a que o CRM guarda);
 * quem digita costuma omitir o 9 (+54 <área><número>). Área argentina começa em 1, 2 ou 3
 * (11 = AMBA, 2xx/3xx = interior): é a guarda contra inventar um 9 em número que não é AR.
 * Ponytail: não distinguimos fixo de celular sem o 9 — a Argentina não tem faixa de
 * celular reconhecível pelos dígitos, e o 9 só é usado por quem tem WhatsApp.
 */
function variantesAR(d: string, original: string): string[] {
  const resto = d.slice(2);
  if (resto.length === 11 && resto[0] === "9" && /^[1-3]/.test(resto.slice(1))) {
    return [original, `+54${resto.slice(1)}`];
  }
  if (resto.length === 10 && /^[1-3]/.test(resto)) return [original, `+549${resto}`];
  return [original];
}

/**
 * Número argentino digitado sem DDI → E.164 canônico (`+549…`), ou null se não for AR.
 * Aceita área+número (10 dígitos) e o formato local com tronco `0` e/ou `15`
 * (`011 15 1234-5678`). O `15` só é removido quando há UMA posição possível
 * (área de 2, 3 ou 4 dígitos); ambíguo → null, não adivinhamos.
 */
export function arSemDdiParaE164(digits: string): string | null {
  let n = digits;
  if (n.startsWith("0")) {
    n = n.slice(1);
    if (n.length === 12) {
      const pos = [2, 3, 4].filter((a) => n.slice(a, a + 2) === "15");
      if (pos.length !== 1) return null;
      n = n.slice(0, pos[0]) + n.slice(pos[0]! + 2);
    }
  }
  return n.length === 10 && /^[1-3]/.test(n) ? `+549${n}` : null;
}

/**
 * Formas pelas quais este número pode estar gravado. A primeira é sempre a original;
 * a segunda (quando existe) é a contraparte com/sem o nono dígito.
 *
 * Devolve E.164 **com `+`**, que é como `contacts.phone_number` guarda.
 */
export function phoneLookupVariants(raw: string): string[] {
  const d = digitsOf(raw);
  if (d.length === 0) return [];

  const original = `+${d}`;
  if (d.startsWith("54")) return variantesAR(d, original);
  // Fora do Brasil e da Argentina o nono dígito não existe — variante única, sem inventar regra.
  if (!d.startsWith("55")) return [original];

  const ddd = d.slice(2, 4);
  const local = d.slice(4);
  // DDD brasileiro válido começa em 1 (11..99). Fora disso não arriscamos nada.
  if (ddd.length !== 2 || !/^[1-9][0-9]$/.test(ddd)) return [original];

  // 12 dígitos: 55 + DDD + 8 locais. Celular antigo perdeu o 9 → a variante o devolve.
  // Só quando o local começa em 6-9, que é a faixa de celular; 2-5 é fixo e fica fora.
  if (local.length === 8) {
    if (!/^[6-9]/.test(local)) return [original];
    return [original, `+55${ddd}9${local}`];
  }

  // 13 dígitos: 55 + DDD + 9 locais começando em 9 → a variante remove o nono.
  //
  // A checagem do que SOBRA é o que torna esta direção tão prudente quanto a outra.
  // Sem ela, um `9` grudado num número de fixo (5531 9 3234-5678) geraria a variante
  // 553132345678 — que é o fixo REAL de outra pessoa. Regra generosa na volta desfaz
  // a cautela da ida, e a fusão de dois contatos não tem retorno.
  if (local.length === 9 && local.startsWith("9") && /^[6-9]/.test(local.slice(1))) {
    return [original, `+55${ddd}${local.slice(1)}`];
  }

  return [original];
}

/**
 * Forma canônica de CRM: celular BR sempre COM o nono dígito.
 *
 * Entre as variantes de busca, a mais longa é a que tem o 9. Fixo e estrangeiro
 * só têm uma variante — devolvem o próprio número.
 */
export function canonicalPhoneBR(raw: string): string {
  const variants = phoneLookupVariants(raw);
  if (variants.length === 0) return raw.trim();
  return variants.reduce((a, b) => (digitsOf(a).length >= digitsOf(b).length ? a : b));
}

/** Exibição: mesma regra da gravação. Vazio continua vazio. */
export function phoneForDisplay(raw: string | null | undefined): string {
  if (raw == null || !raw.trim()) return "";
  return canonicalPhoneBR(raw);
}

/**
 * Os dois números são a MESMA pessoa, considerando o nono dígito?
 *
 * Útil para asserção e para decidir merge.
 */
export function samePhone(a: string, b: string): boolean {
  const va = new Set(phoneLookupVariants(a));
  return phoneLookupVariants(b).some((v) => va.has(v));
}
