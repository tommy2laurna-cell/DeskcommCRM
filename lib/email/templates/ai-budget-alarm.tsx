/**
 * AI budget alarm email (español rioplatense). Plain HTML — no React Email runtime.
 *
 * SEM CHAMADOR HOJE. O único era `workers/ai-budget-checker.cron.ts`, apagado na
 * limpeza do teto de orçamento (0159) por nunca ter tido agendador. Quem avisa o
 * cliente que o gasto passou do ponto escolhido é o item `budget_warning` na
 * Central (`agent_inbox_items`), aberto pelo próprio gate. Este arquivo fica de
 * pé porque o alarme POR E-MAIL continua sendo uma peça desejada. A marca entra
 * resolvida (`marcaDaSaida(organizationId)`), como em `invite.ts`: a dívida D1
 * de marca está paga e o e-mail não escreve o nome do produto original.
 */
import type { MarcaDeSaida } from "@/lib/branding/saida";

export interface BudgetAlarmEmailOptions {
  pct: number;
  consumedCents: number;
  limitCents: number;
  orgName?: string | null;
  dashboardUrl: string;
  /** A marca da instalação. Obrigatória — sem ela o e-mail não tem dono. */
  marca: MarcaDeSaida;
}

const brl = new Intl.NumberFormat("es-AR", {
  style: "currency",
  currency: "USD",
});

function fmt(cents: number): string {
  return brl.format(cents / 100);
}

export function buildBudgetAlarmEmail(opts: BudgetAlarmEmailOptions): {
  subject: string;
  html: string;
  text: string;
} {
  const pctStr = `${opts.pct.toFixed(2)}%`;
  const subject = `Alerta de IA: el presupuesto llegó al ${pctStr} — ${opts.marca.nome}`;
  const orgLine = opts.orgName
    ? `<p style="margin:0 0 16px;font-size:14px;color:#57534e">Organización: <strong>${escapeHtml(opts.orgName)}</strong></p>`
    : "";

  const html = `<!doctype html>
<html lang="es-AR">
<body style="margin:0;padding:0;background:#f5f5f4;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#1c1917">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px">
    <h1 style="font-size:22px;line-height:1.3;margin:0 0 16px;color:#0c0a09">
      El presupuesto mensual de IA llegó al ${escapeHtml(pctStr)}
    </h1>
    ${orgLine}
    <p style="margin:0 0 12px;font-size:15px;line-height:1.5">
      Consumo del mes: <strong>${escapeHtml(fmt(opts.consumedCents))}</strong>
      de <strong>${escapeHtml(fmt(opts.limitCents))}</strong>.
    </p>
    <p style="margin:0 0 16px;font-size:14px;color:#57534e">
      Al llegar al 100%, el bot de IA se pausa o se desactiva solo, según la
      política que configuraste. La atención humana sigue normal.
    </p>
    <p style="margin:24px 0">
      <a href="${opts.dashboardUrl}" style="display:inline-block;padding:12px 24px;background:#0ea5e9;color:#ffffff;border-radius:6px;text-decoration:none;font-weight:600">
        Ver el panel de uso
      </a>
    </p>
    <p style="margin:24px 0 0;font-size:12px;color:#78716c">
      Esta alerta se envía sola una vez cada 24 h mientras el consumo siga por
      encima del límite que configuraste.
    </p>
  </div>
</body>
</html>`;

  const text = [
    `El presupuesto mensual de IA llegó al ${pctStr}.`,
    opts.orgName ? `Organización: ${opts.orgName}` : "",
    `Consumo: ${fmt(opts.consumedCents)} de ${fmt(opts.limitCents)}.`,
    "",
    `Panel: ${opts.dashboardUrl}`,
  ]
    .filter(Boolean)
    .join("\n");

  return { subject, html, text };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
