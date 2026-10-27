import { describe, it, expect } from "vitest";
import { mapInboundPayload, normalizePhoneBR, verifyInboundSignature } from "@/lib/webhooks/inbound";
import { createHmac } from "node:crypto";

describe("normalizePhoneBR", () => {
  it("já em E.164 com o nono passa direto", () => expect(normalizePhoneBR("+5511998765432")).toBe("+5511998765432"));
  it("DDD+numero BR ganha +55", () => expect(normalizePhoneBR("11 99876-5432")).toBe("+5511998765432"));
  it("com 55 na frente sem +", () => expect(normalizePhoneBR("5511998765432")).toBe("+5511998765432"));
  it("celular antigo sem o nono ganha o 9", () => {
    expect(normalizePhoneBR("+553284793302")).toBe("+5532984793302");
    expect(normalizePhoneBR("553284793302")).toBe("+5532984793302");
  });
  it("fixo BR 10 dígitos com DDI", () => expect(normalizePhoneBR("551133334444")).toBe("+551133334444"));
  it("BR com DDD fora de 1-3 sem DDI segue +55 como antes", () => {
    expect(normalizePhoneBR("4133334444")).toBe("+554133334444");
    expect(normalizePhoneBR("(85) 99999-8888")).toBe("+5585999998888");
  });
  it("lixo → null", () => expect(normalizePhoneBR("abc")).toBeNull());
  it("vazio/não-string → null", () => {
    expect(normalizePhoneBR("")).toBeNull();
    expect(normalizePhoneBR(42 as unknown)).toBeNull();
  });
});

describe("mapInboundPayload", () => {
  it("aliases default: nome/telefone/email", () => {
    const m = mapInboundPayload({ nome: "Ana", telefone: "11998765432", email: "a@b.com" });
    expect(m).toMatchObject({ name: "Ana", phone: "+5511998765432", email: "a@b.com" });
  });
  it("whatsapp como alias de phone; extras viram custom_fields; utm_* vira source_metadata", () => {
    const m = mapInboundPayload({ name: "Bo", whatsapp: "+5511998765432", empresa: "ACME", utm_source: "instagram" });
    expect(m.phone).toBe("+5511998765432");
    expect(m.custom_fields).toEqual({ empresa: "ACME" });
    expect(m.source_metadata).toEqual({ utm_source: "instagram" });
  });
  it("field_map custom tem precedência sobre defaults", () => {
    const m = mapInboundPayload({ contato: "Zé" }, { name: ["contato"] });
    expect(m.name).toBe("Zé");
  });
  it("payload sem nada mapeável → tudo null e extras preservados", () => {
    const m = mapInboundPayload({ foo: "bar" });
    expect(m.name).toBeNull();
    expect(m.phone).toBeNull();
    expect(m.custom_fields).toEqual({ foo: "bar" });
  });
  it("valores não-string são stringificados em custom_fields; objetos aninhados descartados", () => {
    const m = mapInboundPayload({ nome: "Ana", idade: 30, nested: { a: 1 } });
    expect(m.custom_fields).toEqual({ idade: "30" });
  });
});

describe("verifyInboundSignature", () => {
  const body = '{"nome":"Ana"}';
  const secret = "s3cr3t";
  const sig = createHmac("sha256", secret).update(body).digest("hex");
  it("assinatura válida", () => expect(verifyInboundSignature(body, sig, secret)).toBe(true));
  it("assinatura errada", () => expect(verifyInboundSignature(body, "deadbeef", secret)).toBe(false));
  it("header ausente", () => expect(verifyInboundSignature(body, null, secret)).toBe(false));
  it("header com tamanho diferente não lança (timingSafeEqual exige mesmo length)", () =>
    expect(verifyInboundSignature(body, "abc", secret)).toBe(false));
});

describe("normalizePhoneBR — Argentina (+54 9)", () => {
  // Todas as grafias de um mesmo celular de Buenos Aires.
  it.each([
    "11 1234-5678",
    "011 15 1234-5678",
    "011 1234-5678",
    "+54 11 1234 5678",
    "+54 9 11 1234 5678",
    "5491112345678",
    "541112345678",
  ])("%s → +5491112345678", (raw) => expect(normalizePhoneBR(raw)).toBe("+5491112345678"));

  it("área de 3 e 4 dígitos com 0 e 15", () => {
    expect(normalizePhoneBR("0221 15 456-7890")).toBe("+5492214567890");
    expect(normalizePhoneBR("02966 15 12 3456")).toBe("+5492966123456");
  });

  it("não adivinha: 15 ambíguo ou fora do padrão → null", () => {
    expect(normalizePhoneBR("011 15 15 123456")).toBeNull(); // "15" en dos posiciones posibles (área 11 o 1115)
    expect(normalizePhoneBR("011 12 1234-5678")).toBeNull(); // 12 dígitos após o 0 sem "15"
    expect(normalizePhoneBR("0123")).toBeNull();
  });

  it("Brasil com DDI não muda", () => {
    expect(normalizePhoneBR("+55 11 99876-5432")).toBe("+5511998765432");
    expect(normalizePhoneBR("5511998765432")).toBe("+5511998765432");
    expect(normalizePhoneBR("11998765432")).toBe("+5511998765432");
  });
});
