-- 0001_inicial.sql. No se edita nunca una vez publicada: se agrega 0002, 0003...
-- (sqlx guarda el checksum de cada migración; si cambia, la app no abre en las PCs que ya la aplicaron)
-- Los archivos van siempre con LF (ver .gitattributes): CRLF cambia el checksum.

CREATE TABLE ajuste (
  clave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);

CREATE TABLE etapa (
  id INTEGER PRIMARY KEY,
  nombre TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (trim(nombre) <> ''),
  orden INTEGER NOT NULL,
  color TEXT CHECK (color IS NULL OR color GLOB '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'),
  dias_estancada INTEGER NOT NULL DEFAULT 7 CHECK (dias_estancada > 0),
  cierre TEXT CHECK (cierre IN ('ganada', 'perdida')),
  activa INTEGER NOT NULL DEFAULT 1 CHECK (activa IN (0, 1))
);

CREATE TABLE cuenta (
  id INTEGER PRIMARY KEY,
  nombre TEXT NOT NULL CHECK (trim(nombre) <> ''),
  cuit TEXT, telefono TEXT, email TEXT, notas TEXT,
  extra TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra)),
  creada TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  actualizada TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  borrada TEXT,
  -- Texto sin tildes ni mayúsculas para buscar ("alvarez" encuentra "Álvarez")
  busqueda TEXT GENERATED ALWAYS AS (lower(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(nombre || ' ' || coalesce(cuit, '') || ' ' || coalesce(telefono, '') || ' ' || coalesce(email, ''),'Á','a'),'É','e'),'Í','i'),'Ó','o'),'Ú','u'),'Ü','u'),'Ñ','n'),'á','a'),'é','e'),'í','i'),'ó','o'),'ú','u'),'ü','u'),'ñ','n'))) VIRTUAL
);

CREATE TABLE contacto (
  id INTEGER PRIMARY KEY,
  cuenta_id INTEGER REFERENCES cuenta(id) ON DELETE SET NULL,
  nombre TEXT NOT NULL CHECK (trim(nombre) <> ''),
  telefono TEXT, email TEXT, notas TEXT,
  extra TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra)),
  creado TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  actualizado TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  borrado TEXT,
  busqueda TEXT GENERATED ALWAYS AS (lower(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(nombre || ' ' || coalesce(telefono, '') || ' ' || coalesce(email, ''),'Á','a'),'É','e'),'Í','i'),'Ó','o'),'Ú','u'),'Ü','u'),'Ñ','n'),'á','a'),'é','e'),'í','i'),'ó','o'),'ú','u'),'ü','u'),'ñ','n'))) VIRTUAL
);

CREATE TABLE oportunidad (
  id INTEGER PRIMARY KEY,
  contacto_id INTEGER NOT NULL REFERENCES contacto(id) ON DELETE RESTRICT,
  titulo TEXT NOT NULL CHECK (trim(titulo) <> ''),
  etapa_id INTEGER NOT NULL REFERENCES etapa(id) ON DELETE RESTRICT,
  en_etapa_desde TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  monto_centavos INTEGER CHECK (monto_centavos >= 0),
  moneda TEXT NOT NULL DEFAULT 'ARS',
  motivo_perdida TEXT,
  cerrada TEXT,
  extra TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra)),
  creada TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  actualizada TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  borrada TEXT
);

-- Una tarea es un toque de tipo 'tarea': siempre con fecha (YYYY-MM-DD real), y solo ella puede tener fecha o estar hecha.
CREATE TABLE toque (
  id INTEGER PRIMARY KEY,
  contacto_id INTEGER NOT NULL REFERENCES contacto(id) ON DELETE CASCADE,
  oportunidad_id INTEGER REFERENCES oportunidad(id) ON DELETE SET NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('nota', 'llamada', 'whatsapp', 'mail', 'reunion', 'tarea')),
  texto TEXT NOT NULL CHECK (trim(texto) <> ''),
  vence TEXT CHECK ((tipo = 'tarea' AND vence IS NOT NULL AND date(vence) IS vence) OR (tipo <> 'tarea' AND vence IS NULL)),
  hecho TEXT CHECK (hecho IS NULL OR tipo = 'tarea'),
  creado TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX oportunidad_por_etapa ON oportunidad(etapa_id) WHERE borrada IS NULL;
CREATE INDEX toque_tareas_abiertas ON toque(vence) WHERE tipo = 'tarea' AND hecho IS NULL;
CREATE INDEX toque_por_contacto ON toque(contacto_id, creado);
CREATE INDEX contacto_por_nombre ON contacto(nombre COLLATE NOCASE);
-- Claves foráneas que se consultan desde el lado de los hijos: sin estos dos, "estancadas" y la lista de
-- contactos recorren la tabla entera por cada fila.
CREATE INDEX oportunidad_por_contacto ON oportunidad(contacto_id);
CREATE INDEX toque_por_oportunidad ON toque(oportunidad_id);

-- Perder sin motivo no se puede, ni al cambiar de etapa, ni al dar de alta, ni al borrar el motivo después.
CREATE TRIGGER oportunidad_motivo_perdida BEFORE UPDATE OF etapa_id, motivo_perdida ON oportunidad
WHEN (SELECT cierre FROM etapa WHERE id = NEW.etapa_id) = 'perdida'
 AND (NEW.motivo_perdida IS NULL OR trim(NEW.motivo_perdida) = '')
BEGIN SELECT RAISE(ABORT, 'motivo_perdida obligatorio'); END;

CREATE TRIGGER oportunidad_alta_motivo_perdida BEFORE INSERT ON oportunidad
WHEN (SELECT cierre FROM etapa WHERE id = NEW.etapa_id) = 'perdida'
 AND (NEW.motivo_perdida IS NULL OR trim(NEW.motivo_perdida) = '')
BEGIN SELECT RAISE(ABORT, 'motivo_perdida obligatorio'); END;

-- Cambio de etapa: reinicia el reloj de estancada y marca (o desmarca) el cierre.
CREATE TRIGGER oportunidad_cambia_etapa AFTER UPDATE OF etapa_id ON oportunidad
WHEN NEW.etapa_id <> OLD.etapa_id
BEGIN
  UPDATE oportunidad
     SET en_etapa_desde = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
         cerrada = CASE WHEN (SELECT cierre FROM etapa WHERE id = NEW.etapa_id) IS NOT NULL
                        THEN strftime('%Y-%m-%dT%H:%M:%SZ', 'now') END
   WHERE id = NEW.id;
END;

CREATE TRIGGER oportunidad_alta_cerrada AFTER INSERT ON oportunidad
WHEN NEW.cerrada IS NULL AND (SELECT cierre FROM etapa WHERE id = NEW.etapa_id) IS NOT NULL
BEGIN UPDATE oportunidad SET cerrada = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = NEW.id; END;

-- Una etapa con oportunidades no puede pasar a cerrar (ganada/perdida) ni dejar de hacerlo: dejaría 'cerrada' desfasada.
CREATE TRIGGER etapa_cierre_con_oportunidades BEFORE UPDATE OF cierre ON etapa
WHEN NEW.cierre IS NOT OLD.cierre AND EXISTS (SELECT 1 FROM oportunidad WHERE etapa_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'etapa con oportunidades: no se puede cambiar si cierra'); END;

-- actualizado/actualizada: solo si quien actualiza no lo tocó (así el trigger no se dispara a sí mismo)
CREATE TRIGGER cuenta_actualizada AFTER UPDATE ON cuenta WHEN NEW.actualizada IS OLD.actualizada
BEGIN UPDATE cuenta SET actualizada = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = NEW.id; END;

CREATE TRIGGER contacto_actualizado AFTER UPDATE ON contacto WHEN NEW.actualizado IS OLD.actualizado
BEGIN UPDATE contacto SET actualizado = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = NEW.id; END;

CREATE TRIGGER oportunidad_actualizada AFTER UPDATE ON oportunidad WHEN NEW.actualizada IS OLD.actualizada
BEGIN UPDATE oportunidad SET actualizada = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = NEW.id; END;
