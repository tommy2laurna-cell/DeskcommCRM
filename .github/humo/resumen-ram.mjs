// Lee el CSV de ram.sh y arma la tabla: contenedor, RAM en reposo (primera
// muestra tras el arranque), RAM pico (máximo de la corrida).
// Uso: node resumen-ram.mjs <ram.csv> [marca-epoch-inicio-journeys]
// Con la marca, "reposo" = última muestra anterior a los journeys (stack asentado).
import { readFileSync } from "node:fs";

const unidad = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, kB: 1e3, MB: 1e6, GB: 1e9 };
const aMiB = (s) => {
  const m = /^([\d.]+)\s*([A-Za-z]+)$/.exec(s.trim());
  return m ? (Number(m[1]) * (unidad[m[2]] ?? NaN)) / 1024 ** 2 : NaN;
};

const filas = readFileSync(process.argv[2], "utf8").trim().split("\n").filter(Boolean)
  .map((l) => l.split("|")).map(([ts, nombre, uso]) => ({ ts: +ts, nombre, mib: aMiB(uso) }))
  .filter((f) => Number.isFinite(f.mib));
if (filas.length === 0) { console.log("_Sin muestras de RAM (NO MEDIDO)._"); process.exit(0); }

const t0 = Math.min(...filas.map((f) => f.ts));
const porNombre = new Map();
for (const f of filas) (porNombre.get(f.nombre) ?? porNombre.set(f.nombre, []).get(f.nombre)).push(f);

const esSupabase = (n) => /^supabase_/.test(n);
const marca = process.argv[3] ? Number(process.argv[3]) : null;
const fila = (n, xs) => {
  xs.sort((a, b) => a.ts - b.ts);
  const previas = marca ? xs.filter((x) => x.ts <= marca) : [];
  const reposo = (previas.length ? previas[previas.length - 1] : xs[0]).mib;
  return { n, reposo, pico: Math.max(...xs.map((x) => x.mib)), muestras: xs.length };
};
const todos = [...porNombre].map(([n, xs]) => fila(n, xs));
const nuestros = todos.filter((r) => !esSupabase(r.n)).sort((a, b) => b.pico - a.pico);
const supa = todos.filter((r) => esSupabase(r.n));

const f1 = (x) => x.toFixed(0);
const tabla = (rs) => ["| Contenedor | RAM en reposo (MiB) | RAM pico (MiB) | Muestras |", "|---|--:|--:|--:|",
  ...rs.map((r) => `| ${r.n} | ${f1(r.reposo)} | ${f1(r.pico)} | ${r.muestras} |`)].join("\n");
const suma = (rs, k) => rs.reduce((a, r) => a + r[k], 0);

const dur = Math.round((Math.max(...filas.map((f) => f.ts)) - t0) / 60);
const totalR = suma(nuestros, "reposo"), totalP = suma(nuestros, "pico");
const pct = (x, gb) => `${((x / (gb * 1024)) * 100).toFixed(0)} %`;
console.log(`### RAM de los contenedores del CRM (${dur} min de corrida, muestra cada 30 s)\n`);
console.log(tabla(nuestros));
console.log(`\n**Total CRM:** reposo ${f1(totalR)} MiB · pico (suma de picos) ${f1(totalP)} MiB`);
console.log(`\n| Contra un VPS de | Reposo | Pico |\n|---|--:|--:|\n| 4 GB | ${pct(totalR, 4)} | ${pct(totalP, 4)} |\n| 2 GB | ${pct(totalR, 2)} | ${pct(totalP, 2)} |`);
console.log(`\n_Sin contar el SO ni Supabase: en el VPS la base es Supabase (nube o autoalojada). La suma de picos es un techo: los picos no coinciden en el tiempo._`);
console.log(`\n<details><summary>Stack local de Supabase en el runner (no va en el VPS del CRM)</summary>\n\n${tabla(supa.sort((a, b) => b.pico - a.pico))}\n\nTotal Supabase local: reposo ${f1(suma(supa, "reposo"))} MiB · pico ${f1(suma(supa, "pico"))} MiB\n</details>`);
