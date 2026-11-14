/**
 * Genera una base del CRM Base de ejemplo: aplica SUS migraciones (las mismas que corre la app) y carga datos
 * que tocan cada caso del mapeo (cierres repetidos, cuenta, campos propios, teléfono raro, borrados, tareas).
 *
 *   npx tsx lrn/scripts/fixture-base.ts <salida.sqlite> [carpeta-de-migraciones]
 *
 * Por defecto usa lrn/fixtures/base-migraciones (copia exacta de src-tauri/migrations del CRM Base 0.1.1; al sacar una
 * versión nueva del Base hay que copiar la migración nueva ahí). Otra carpeta: 2.º argumento o BASE_MIGRACIONES.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function crearFixture(salida: string, migraciones: string): void {
  if (fs.existsSync(salida)) fs.rmSync(salida);
  const db = new DatabaseSync(salida);
  const archivos = fs.readdirSync(migraciones).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  if (archivos.length === 0) throw new Error(`Sin migraciones en ${migraciones}`);
  for (const f of archivos) db.exec(fs.readFileSync(path.join(migraciones, f), "utf8"));
  db.exec(`
    INSERT INTO embudo(id, nombre, orden) VALUES (2, 'Postventa', 2);
    INSERT INTO etapa(id, nombre, orden, color, dias_estancada, embudo_id) VALUES
      (1, 'Nuevo', 1, '#3366CC', 5, 1), (2, 'Propuesta enviada', 2, NULL, 7, 1);
    INSERT INTO etapa(id, nombre, orden, cierre, embudo_id) VALUES
      (3, 'Ganada', 3, 'ganada', 1), (4, 'Cerrada con seña', 4, 'ganada', 1), (5, 'Perdida', 5, 'perdida', 1);
    INSERT INTO etapa(id, nombre, orden, embudo_id) VALUES (6, 'Reclamo', 1, 2);
    INSERT INTO etapa(id, nombre, orden, cierre, embudo_id) VALUES (7, 'Resuelto', 2, 'ganada', 2);

    INSERT INTO cuenta(id, nombre, cuit, telefono, notas, extra) VALUES (1, 'Panadería Ñandú SRL', '30-12345678-9', '011 4444-5555', 'Paga a 30 días', '{"rubro":"Alimentos"}');
    INSERT INTO contacto(id, cuenta_id, nombre, telefono, email, notas, extra, cumple) VALUES
      (1, 1, 'Ana Álvarez', '011 15 2345-6789', 'Ana@Ejemplo.com', 'Prefiere WhatsApp', '{"zona":"Palermo"}', '03-14'),
      (2, NULL, 'Bruno Díaz', '+54 9 351 555 0101', NULL, NULL, '{}', NULL),
      (3, NULL, 'Carla Gómez', 'interno 22', 'carla@ejemplo.com', NULL, '{}', NULL),
      (4, NULL, 'Diego Pérez', NULL, NULL, NULL, '{}', NULL),
      (5, NULL, 'Elena (borrada con oportunidad viva)', '0221 15 555-0000', NULL, NULL, '{}', NULL);
    UPDATE contacto SET borrado = '2026-10-01T10:00:00Z' WHERE id IN (4, 5);

    INSERT INTO etiqueta(id, nombre, tono) VALUES (1, 'VIP', 5), (2, 'Referido', 2);
    INSERT INTO contacto_etiqueta VALUES (1, 1), (1, 2), (2, 2);
    INSERT INTO oportunidad(id, contacto_id, titulo, etapa_id, monto_centavos, moneda, extra) VALUES
      (1, 1, 'Web institucional', 2, 12000000, 'ARS', '{"origen":"Instagram"}'),
      (2, 2, 'Mantenimiento', 4, 4500000, 'ARS', '{}'),
      (3, 2, 'Rediseño de logo', 1, NULL, 'pesos', '{}'),
      (4, 3, 'Landing', 3, 80000, 'USD', '{}'),
      (5, 5, 'Reclamo de entrega', 6, NULL, 'ARS', '{}');
    INSERT INTO oportunidad(id, contacto_id, titulo, etapa_id, motivo_perdida) VALUES (6, 3, 'Tienda online', 5, 'Precio');
    INSERT INTO oportunidad(id, contacto_id, titulo, etapa_id) VALUES (7, 1, 'Oportunidad borrada', 1);
    UPDATE oportunidad SET borrada = '2026-10-02T10:00:00Z' WHERE id = 7;
    INSERT INTO oportunidad_etiqueta VALUES (1, 1);

    INSERT INTO toque(contacto_id, oportunidad_id, tipo, texto) VALUES
      (1, 1, 'nota', 'Pidió presupuesto con dominio incluido'), (1, NULL, 'llamada', 'Llamó para confirmar la reunión'),
      (2, 2, 'whatsapp', 'Mandé el contrato'), (3, 6, 'mail', 'Respondió que es caro'), (2, NULL, 'reunion', 'Reunión en Córdoba');
    INSERT INTO toque(contacto_id, oportunidad_id, tipo, texto, vence) VALUES
      (1, 1, 'tarea', 'Mandar propuesta v2', '2026-11-20'), (2, 2, 'tarea', 'Cobrar la seña', '2026-10-30');
    UPDATE toque SET hecho = '2026-10-31T09:00:00Z' WHERE texto = 'Cobrar la seña';
    INSERT INTO lista(sobre, nombre, filtros) VALUES ('contactos', 'Clientes de Palermo', '{"zona":"Palermo"}');
  `);
  db.close();
}

if (process.argv[1]?.endsWith("fixture-base.ts")) {
  const [salida, mig] = process.argv.slice(2);
  if (!salida) throw new Error("Uso: fixture-base.ts <salida.sqlite> [carpeta-de-migraciones]");
  crearFixture(salida, mig ?? process.env.BASE_MIGRACIONES ?? path.join(process.cwd(), "lrn/fixtures/base-migraciones"));
  console.log(`Fixture escrito en ${salida}`);
}
