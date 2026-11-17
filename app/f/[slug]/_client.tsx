"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CAMPO_SENUELO, CLAVES_UTM, RESPUESTAS_SI_NO, type Campo } from "@/lib/captar/formulario";

export interface TextosDelFormulario {
  enviar: string;
  enviando: string;
  obligatorio: string;
  telefonoInvalido: string;
  emailInvalido: string;
  opcionInvalida: string;
  fechaInvalida: string;
  elegi: string;
  si: string;
  no: string;
  aceptar: string;
  errorGeneral: string;
  demasiados: string;
}

interface Props {
  slug: string;
  campos: Campo[];
  consentimiento: string;
  textos: TextosDelFormulario;
}

/** Los `utm_*` de la dirección con la que se abrió el formulario (link, QR o la web que lo incrusta). */
function utmDeLaDireccion(): Record<string, string> {
  const q = new URLSearchParams(window.location.search);
  const out: Record<string, string> = {};
  for (const k of CLAVES_UTM) {
    const v = q.get(k);
    if (v) out[k] = v;
  }
  return out;
}

export function FormularioPublico({ slug, campos, consentimiento, textos }: Props) {
  const [valores, setValores] = useState<Record<string, string>>({});
  const [acepta, setAcepta] = useState(false);
  const [errores, setErrores] = useState<Record<string, string>>({});
  const [enviando, setEnviando] = useState(false);
  const [gracias, setGracias] = useState<string | null>(null);
  const [fallo, setFallo] = useState<string | null>(null);
  const raiz = useRef<HTMLDivElement>(null);

  // Dentro de un iframe, le avisa a la página que lo hospeda cuánto mide.
  useEffect(() => {
    if (window.parent === window || !raiz.current) return;
    const el = raiz.current;
    const avisar = () => window.parent.postMessage({ tipo: "formulario-alto", alto: el.scrollHeight + 32 }, "*");
    avisar();
    const ro = new ResizeObserver(avisar);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const mensajeDe = (codigo: string): string => {
    switch (codigo) {
      case "telefono_invalido":
        return textos.telefonoInvalido;
      case "email_invalido":
        return textos.emailInvalido;
      case "opcion_invalida":
        return textos.opcionInvalida;
      case "fecha_invalida":
        return textos.fechaInvalida;
      default:
        return textos.obligatorio;
    }
  };

  async function enviar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFallo(null);
    setEnviando(true);
    const senuelo = (new FormData(e.currentTarget).get(CAMPO_SENUELO) as string | null) ?? "";
    try {
      const res = await fetch(`/api/v1/captar/publico/${slug}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          respuestas: valores,
          consentimiento: acepta,
          utm: utmDeLaDireccion(),
          [CAMPO_SENUELO]: senuelo,
        }),
      });
      const cuerpo = (await res.json().catch(() => null)) as {
        data?: { mensaje?: string };
        error?: { details?: Record<string, string> };
      } | null;
      if (res.ok) {
        setErrores({});
        setGracias(cuerpo?.data?.mensaje ?? "");
      } else if (res.status === 400 && cuerpo?.error?.details) {
        setErrores(cuerpo.error.details);
      } else {
        setFallo(res.status === 429 ? textos.demasiados : textos.errorGeneral);
      }
    } catch {
      setFallo(textos.errorGeneral);
    } finally {
      setEnviando(false);
    }
  }

  if (gracias !== null) {
    return (
      <div ref={raiz} role="status" data-testid="formulario-gracias" className="rounded-md border border-border p-4 text-sm">
        {gracias}
      </div>
    );
  }

  const poner = (id: string, v: string) => setValores((p) => ({ ...p, [id]: v }));

  return (
    <div ref={raiz}>
      <form onSubmit={enviar} noValidate className="flex flex-col gap-4" data-testid="formulario-publico">
        {campos.map((c) => (
          <div key={c.id} className="flex flex-col gap-1.5">
            <label htmlFor={`campo-${c.id}`} className="text-sm font-medium">
              {c.label}
              {c.requerido ? " *" : ""}
            </label>
            {c.tipo === "opcion" ? (
              <select
                id={`campo-${c.id}`}
                name={c.id}
                value={valores[c.id] ?? ""}
                onChange={(e) => poner(c.id, e.target.value)}
                aria-invalid={errores[c.id] ? true : undefined}
                className="h-10 rounded-sm border border-border bg-bg px-3 text-sm"
              >
                <option value="">{textos.elegi}</option>
                {(c.opciones ?? []).map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : c.tipo === "si_no" ? (
              <div className="flex gap-4" role="radiogroup" aria-labelledby={`campo-${c.id}`}>
                {RESPUESTAS_SI_NO.map((r, i) => (
                  <label key={r} className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name={c.id}
                      value={r}
                      checked={valores[c.id] === r}
                      onChange={() => poner(c.id, r)}
                    />
                    {i === 0 ? textos.si : textos.no}
                  </label>
                ))}
              </div>
            ) : (
              <Input
                id={`campo-${c.id}`}
                name={c.id}
                type={c.tipo === "email" ? "email" : c.tipo === "telefono" ? "tel" : c.tipo === "fecha" ? "date" : "text"}
                inputMode={c.tipo === "telefono" ? "tel" : undefined}
                autoComplete={c.id === "nombre" ? "name" : c.tipo === "telefono" ? "tel" : c.tipo === "email" ? "email" : "off"}
                value={valores[c.id] ?? ""}
                onChange={(e) => poner(c.id, e.target.value)}
                aria-invalid={errores[c.id] ? true : undefined}
              />
            )}
            {errores[c.id] ? (
              <p className="text-xs text-error" role="alert">
                {mensajeDe(errores[c.id]!)}
              </p>
            ) : null}
          </div>
        ))}

        {/* Señuelo: fuera de la vista y del teclado. Una persona no lo completa. */}
        <div aria-hidden="true" style={{ position: "absolute", left: "-10000px", top: "auto", width: 1, height: 1, overflow: "hidden" }}>
          <label>
            Sitio web
            <input type="text" name={CAMPO_SENUELO} tabIndex={-1} autoComplete="off" />
          </label>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="flex items-start gap-2 text-xs text-text-muted">
            <input
              type="checkbox"
              name="consentimiento"
              checked={acepta}
              onChange={(e) => setAcepta(e.target.checked)}
              className="mt-0.5"
            />
            <span>{consentimiento}</span>
          </label>
          {errores.consentimiento ? (
            <p className="text-xs text-error" role="alert">
              {textos.aceptar}
            </p>
          ) : null}
        </div>

        {fallo ? (
          <p className="text-sm text-error" role="alert">
            {fallo}
          </p>
        ) : null}

        <Button type="submit" disabled={enviando}>
          {enviando ? textos.enviando : textos.enviar}
        </Button>
      </form>
    </div>
  );
}
