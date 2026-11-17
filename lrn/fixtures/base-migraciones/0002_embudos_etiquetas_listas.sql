-- 0002_embudos_etiquetas_listas.sql. No se edita nunca una vez publicada: se agrega 0003...
-- Los archivos van siempre con LF (ver .gitattributes): CRLF cambia el checksum.
-- Sobre una base 0.1.x con datos: las etapas y oportunidades de hoy quedan en el embudo «Ventas» (id 1), sin tocar una fila.

CREATE TABLE embudo (
  id INTEGER PRIMARY KEY,
  nombre TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (trim(nombre) <> ''),
  orden INTEGER NOT NULL,
  activo INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0, 1))
);
INSERT INTO embudo(id, nombre, orden) VALUES (1, 'Ventas', 1);

-- Toda etapa de hoy pasa al embudo 1 por el DEFAULT. Sin REFERENCES: SQLite no deja agregar una columna con clave foránea
-- y DEFAULT no nulo; la integridad la cuidan los dos triggers de abajo. (Etapa.nombre sigue siendo único en toda la base.)
ALTER TABLE etapa ADD COLUMN embudo_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX etapa_por_embudo ON etapa(embudo_id, orden);

CREATE TRIGGER etapa_embudo_alta BEFORE INSERT ON etapa
WHEN NOT EXISTS (SELECT 1 FROM embudo WHERE id = NEW.embudo_id)
BEGIN SELECT RAISE(ABORT, 'embudo inexistente'); END;

CREATE TRIGGER etapa_embudo_cambia BEFORE UPDATE OF embudo_id ON etapa
WHEN NOT EXISTS (SELECT 1 FROM embudo WHERE id = NEW.embudo_id)
BEGIN SELECT RAISE(ABORT, 'embudo inexistente'); END;

CREATE TRIGGER embudo_con_etapas BEFORE DELETE ON embudo
WHEN EXISTS (SELECT 1 FROM etapa WHERE embudo_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'embudo con etapas'); END;

-- Etiquetas. `tono` es una posición de la escala del acento de la marca (src/lib/etiquetas.ts): el color no se guarda.
CREATE TABLE etiqueta (
  id INTEGER PRIMARY KEY,
  nombre TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (trim(nombre) <> ''),
  tono INTEGER NOT NULL DEFAULT 3 CHECK (tono BETWEEN 0 AND 7)
);

CREATE TABLE contacto_etiqueta (
  contacto_id INTEGER NOT NULL REFERENCES contacto(id) ON DELETE CASCADE,
  etiqueta_id INTEGER NOT NULL REFERENCES etiqueta(id) ON DELETE CASCADE,
  PRIMARY KEY (contacto_id, etiqueta_id)
) WITHOUT ROWID;
CREATE INDEX contacto_etiqueta_por_etiqueta ON contacto_etiqueta(etiqueta_id);

CREATE TABLE oportunidad_etiqueta (
  oportunidad_id INTEGER NOT NULL REFERENCES oportunidad(id) ON DELETE CASCADE,
  etiqueta_id INTEGER NOT NULL REFERENCES etiqueta(id) ON DELETE CASCADE,
  PRIMARY KEY (oportunidad_id, etiqueta_id)
) WITHOUT ROWID;
CREATE INDEX oportunidad_etiqueta_por_etiqueta ON oportunidad_etiqueta(etiqueta_id);

-- Listas guardadas: un filtro con nombre sobre contactos u oportunidades (el JSON lo arma y lo lee src/lib/filtros.ts).
CREATE TABLE lista (
  id INTEGER PRIMARY KEY,
  sobre TEXT NOT NULL CHECK (sobre IN ('contactos', 'oportunidades')),
  nombre TEXT NOT NULL COLLATE NOCASE CHECK (trim(nombre) <> ''),
  filtros TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(filtros)),
  creada TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (sobre, nombre)
);
