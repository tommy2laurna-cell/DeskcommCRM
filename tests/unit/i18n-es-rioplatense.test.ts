import { describe, expect, it } from "vitest";
import { DICIONARIO } from "@/lib/i18n/dicionario";

/**
 * O ESPANHOL É RIOPLATENSE: SEM PORTUGUÊS, SEM «TÚ/USTED», SEM CLAVE FALTANTE.
 *
 * Esta instalação serve clientes argentinos. O guarda irmão
 * `i18n-espanhol-cobre-a-tela` prova que toda chave usada em tela tem entrada;
 * este prova que a ENTRADA está em espanhol rioplatense:
 *
 *  1. toda entrada do dicionário tem `es` (a chave é o texto em português, então
 *     «clave sem tradução» = entrada sem `es`, ou `es` vazio);
 *  2. nenhum valor `es` carrega palavra portuguesa da lista PORTUGUES;
 *  3. nenhum valor `es` tutea («Elige», «Guarda», «Tienes») nem trata de «usted»:
 *     é voseo («Elegí», «Guardá», «Tenés»).
 *
 * Os textos legais (Ley 25.326, CUIT) estão cobertos pelo item 2: «CPF», «LGPD»
 * e «R$» não podem voltar a eles.
 *
 * ─── Como acrescentar uma exceção ──────────────────────────────────────────
 * Em `EXCECOES`, por CHAVE (o texto em português) e por categoria, com o motivo
 * escrito. Exceção sem motivo reprova. A lista não deve crescer sem decisão:
 * o caso comum não é exceção, é bug do valor `es`.
 */

type Categoria = "portugues" | "tuteo";

const EXCECOES: { chave: string; categoria: Categoria; motivo: string }[] = [
  {
    chave: "CPF (opcional)",
    categoria: "portugues",
    motivo:
      "nome próprio do documento brasileiro: o campo está oculto na interface argentina, mas lib/schemas/contacts.ts ainda valida CPF se chegar por API ou importação",
  },
  {
    chave: "CPF inválido: ",
    categoria: "portugues",
    motivo:
      "mensagem do mesmo validador de CPF (lib/schemas/contacts.ts); só aparece se um CPF chegar por API, nunca pelo formulário argentino",
  },
  {
    chave: "Revisa atendimentos já concluídos e julga quais foram bons, para o agente aprender com eles.",
    categoria: "tuteo",
    motivo:
      "descrição de uma ferramenta em terceira pessoa («revisa» = o agente revisa), não um imperativo dirigido a quem lê",
  },
];

/** Palavras portuguesas que não existem em espanhol. */
const PORTUGUES: { nome: string; re: RegExp }[] = [
  { nome: "você", re: /\bvoc[êe]s?\b/i },
  { nome: "não", re: /\bn[ãa]o\b/i },
  { nome: "cadastr", re: /cadastr/i },
  { nome: "funil", re: /\bfun(?:il|is)\b/i },
  { nome: "ção", re: /ç[ãa]o\b|ções\b/i },
  { nome: "obrigad", re: /obrigad/i },
  { nome: "R$", re: /R\$/ },
  { nome: "CPF", re: /\bCPF\b/ },
  { nome: "LGPD", re: /\bLGPD\b/ },
];

/** Tuteo e «usted»: o que o voseo não usa. */
const PRONOMES_E_PRESENTE = [
  /\b(?:tú|contigo|vosotros|vuestro|vuestra)\b/i,
  /\b(?:para|a|de|por|con) ti\b/i,
  /\busted\b/i,
  /\b(?:tienes|puedes|quieres|necesitas|eres|sabes|haces|decides|pierdes|defines|eliges|buscas|hablas|esperas|encuentras|apruebas|piensas|entiendes|prefieres|vienes|dices)\b/i,
];
/** Imperativos de «tú» e «usted» que abrem frase. Em frase de descrição
 *  («Muestra la lista…») o verbo é terceira pessoa — por isso só os que NÃO
 *  têm esse uso no dicionário entram aqui. */
const IMPERATIVO_NA_ABERTURA =
  /(?:^|[.!?:;—] ?)(?:elige|revisa|intenta|recarga|pega|selecciona|haz|ten|vuelve|inténtalo|elija|revise|abra|confirme|configure|solicite|copie|intente|vuelva|seleccione|escriba|guarde|recargue|complete|siga|espere|verifique|ingrese|reintente)(?![\p{L}])/iu;

const ENTRADAS = Object.entries(DICIONARIO) as [string, { es?: string }][];

function excecao(chave: string, categoria: Categoria): boolean {
  return EXCECOES.some((e) => e.chave === chave && e.categoria === categoria);
}

function contar() {
  const faltantes = ENTRADAS.filter(([, v]) => !v.es || v.es.trim() === "");
  const portugues = ENTRADAS.filter(
    ([k, v]) => v.es && PORTUGUES.some((p) => p.re.test(v.es!)) && !excecao(k, "portugues"),
  );
  const tuteo = ENTRADAS.filter(
    ([k, v]) =>
      v.es &&
      (PRONOMES_E_PRESENTE.some((re) => re.test(v.es!)) || IMPERATIVO_NA_ABERTURA.test(v.es!)) &&
      !excecao(k, "tuteo"),
  );
  return { faltantes, portugues, tuteo };
}

describe("o espanhol é rioplatense", () => {
  const { faltantes, portugues, tuteo } = contar();
  // eslint-disable-next-line no-console
  console.info(
    `[i18n-es-rioplatense] entradas=${ENTRADAS.length} sem es=${faltantes.length} ` +
      `com português=${portugues.length} com tuteo/usted=${tuteo.length}`,
  );

  it("toda entrada do dicionário tem `es` preenchido", () => {
    expect(faltantes.map(([k]) => k)).toEqual([]);
  });

  it("nenhum valor `es` carrega português (você, não, cadastr, funil, ção, obrigad, R$, CPF, LGPD)", () => {
    expect(portugues.map(([k, v]) => `${k.slice(0, 60)} → ${v.es!.slice(0, 80)}`)).toEqual([]);
  });

  it("nenhum valor `es` tutea nem trata de «usted» (voseo: Elegí, Guardá, Tenés)", () => {
    expect(tuteo.map(([k, v]) => `${k.slice(0, 50)} → ${v.es!.slice(0, 80)}`)).toEqual([]);
  });

  it("toda exceção declara o motivo e aponta para uma entrada que existe", () => {
    const ruins = EXCECOES.filter(
      (e) => e.motivo.trim().length < 20 || !(e.chave in DICIONARIO),
    ).map((e) => e.chave);
    expect(ruins).toEqual([]);
  });

  it("o detector pega o que deve (casos sintéticos)", () => {
    const pega = (s: string) =>
      PRONOMES_E_PRESENTE.some((re) => re.test(s)) || IMPERATIVO_NA_ABERTURA.test(s);
    for (const mal of ["Elige un canal", "Si tienes dudas", "Guarda y revisa. Haz clic", "Tú decides", "Revise los datos"]) {
      expect(pega(mal), mal).toBe(true);
    }
    for (const bien of ["Elegí un canal", "Si tenés dudas", "Hacé clic", "Pedí a quien administra que revise la conexión"]) {
      expect(pega(bien), bien).toBe(false);
    }
    expect(PORTUGUES.some((p) => p.re.test("Ley 25.326 · CUIT"))).toBe(false);
    expect(PORTUGUES.some((p) => p.re.test("Você não tem CPF"))).toBe(true);
  });
});
