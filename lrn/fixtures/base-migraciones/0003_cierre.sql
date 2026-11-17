-- 0003_cierre.sql: presupuestos, recibos, historial de etapas, origen y recomendado.
-- No se edita nunca una vez publicada: se agrega la siguiente. Siempre con LF (ver .gitattributes).
-- Una base 0.1.x conserva todo: solo se agregan tablas y dos columnas que quedan en NULL.

-- Presupuesto de una oportunidad. Siempre en ARS. Descuento en puntos básicos (1500 = 15 %).
CREATE TABLE presupuesto (
  id INTEGER PRIMARY KEY,
  oportunidad_id INTEGER NOT NULL REFERENCES oportunidad(id) ON DELETE RESTRICT,
  numero INTEGER NOT NULL UNIQUE CHECK (numero > 0),
  emitido TEXT NOT NULL CHECK (date(emitido) IS emitido),
  vence TEXT CHECK (vence IS NULL OR date(vence) IS vence),
  descuento_bp INTEGER NOT NULL DEFAULT 0 CHECK (descuento_bp BETWEEN 0 AND 10000),
  notas TEXT,
  creado TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Cantidad en milésimas (2,5 = 2500) para poder vender por metro o por kilo; precio en centavos.
CREATE TABLE presupuesto_item (
  id INTEGER PRIMARY KEY,
  presupuesto_id INTEGER NOT NULL REFERENCES presupuesto(id) ON DELETE CASCADE,
  orden INTEGER NOT NULL,
  descripcion TEXT NOT NULL CHECK (trim(descripcion) <> ''),
  cantidad_milesimas INTEGER NOT NULL CHECK (cantidad_milesimas > 0),
  precio_centavos INTEGER NOT NULL CHECK (precio_centavos >= 0)
);

-- Recibo: constancia de un cobro que se hizo por fuera. No es una factura.
CREATE TABLE recibo (
  id INTEGER PRIMARY KEY,
  oportunidad_id INTEGER NOT NULL REFERENCES oportunidad(id) ON DELETE RESTRICT,
  numero INTEGER NOT NULL UNIQUE CHECK (numero > 0),
  fecha TEXT NOT NULL CHECK (date(fecha) IS fecha),
  concepto TEXT NOT NULL CHECK (trim(concepto) <> ''),
  monto_centavos INTEGER NOT NULL CHECK (monto_centavos >= 0),
  medio TEXT,
  creado TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Por qué etapas pasó cada oportunidad (para la conversión por etapa del tablero).
-- Las que ya existen entran con la etapa en la que están; el historial se completa desde ahora.
CREATE TABLE etapa_paso (
  oportunidad_id INTEGER NOT NULL REFERENCES oportunidad(id) ON DELETE CASCADE,
  etapa_id INTEGER NOT NULL REFERENCES etapa(id) ON DELETE CASCADE,
  desde TEXT NOT NULL,
  PRIMARY KEY (oportunidad_id, etapa_id, desde)
);
INSERT INTO etapa_paso(oportunidad_id, etapa_id, desde) SELECT id, etapa_id, en_etapa_desde FROM oportunidad;

CREATE TRIGGER oportunidad_paso_alta AFTER INSERT ON oportunidad
BEGIN INSERT OR IGNORE INTO etapa_paso(oportunidad_id, etapa_id, desde) VALUES (NEW.id, NEW.etapa_id, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')); END;

CREATE TRIGGER oportunidad_paso AFTER UPDATE OF etapa_id ON oportunidad
WHEN NEW.etapa_id <> OLD.etapa_id
BEGIN INSERT OR IGNORE INTO etapa_paso(oportunidad_id, etapa_id, desde) VALUES (NEW.id, NEW.etapa_id, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')); END;

-- De dónde llegó el contacto y quién lo recomendó (otro contacto).
ALTER TABLE contacto ADD COLUMN origen TEXT;
ALTER TABLE contacto ADD COLUMN recomendado_por INTEGER REFERENCES contacto(id) ON DELETE SET NULL;

CREATE INDEX presupuesto_por_oportunidad ON presupuesto(oportunidad_id);
CREATE INDEX presupuesto_item_por_presupuesto ON presupuesto_item(presupuesto_id);
CREATE INDEX recibo_por_oportunidad ON recibo(oportunidad_id);
CREATE INDEX contacto_por_recomendado ON contacto(recomendado_por) WHERE recomendado_por IS NOT NULL;
