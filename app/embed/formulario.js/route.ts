/**
 * GET /embed/formulario.js — el script que el cliente pega en su web.
 *
 *   <script src="https://tu-crm/embed/formulario.js" data-formulario="SLUG" async></script>
 *
 * Inserta un iframe con la página pública del formulario (`/f/SLUG`). Es un
 * iframe y no un `fetch` a propósito: el envío ocurre dentro del iframe, contra
 * el mismo origen del CRM, así que no hay CORS de por medio. El script solo
 * hace dos cosas por fuera: pasarle al formulario los `utm_*` de la página que
 * lo hospeda (para que la campaña llegue a la ficha) y ajustar el alto.
 */
export const dynamic = "force-static";

const SCRIPT = `(function () {
  var s = document.currentScript;
  if (!s) return;
  var slug = s.getAttribute("data-formulario");
  if (!slug || !/^[a-z0-9]{8,32}$/.test(slug)) return;
  var origen = new URL(s.src).origin;
  var q = new URLSearchParams();
  q.set("embed", "1");
  var pag = new URLSearchParams(location.search);
  ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"].forEach(function (k) {
    var v = pag.get(k);
    if (v) q.set(k, v);
  });
  var f = document.createElement("iframe");
  f.src = origen + "/f/" + slug + "?" + q.toString();
  f.title = "Formulario";
  f.loading = "lazy";
  f.style.cssText = "width:100%;border:0;min-height:480px;display:block";
  s.parentNode.insertBefore(f, s);
  window.addEventListener("message", function (e) {
    if (e.origin !== origen || e.source !== f.contentWindow) return;
    var d = e.data;
    if (d && d.tipo === "formulario-alto" && typeof d.alto === "number") f.style.height = d.alto + "px";
  });
})();
`;

export function GET(): Response {
  return new Response(SCRIPT, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
