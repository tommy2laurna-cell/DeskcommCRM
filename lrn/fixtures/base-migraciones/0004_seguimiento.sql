-- 0004_seguimiento.sql (GB2). No se edita nunca una vez publicada: se agrega la siguiente.
-- Una base de 0.1.x la aplica encima sin tocar ninguna fila: solo columnas nuevas (todas NULL), tablas nuevas y triggers.
-- Los archivos van siempre con LF (ver .gitattributes): CRLF cambia el checksum.

-- Un turno es una tarea con hora y duración. `avisado` guarda cuándo se mostró el aviso de Windows (NULL = todavía no).
ALTER TABLE toque ADD COLUMN hora TEXT CHECK (hora IS NULL OR (hora GLOB '[0-2][0-9]:[0-5][0-9]' AND hora <= '23:59'));
ALTER TABLE toque ADD COLUMN duracion_min INTEGER CHECK (duracion_min IS NULL OR duracion_min > 0);
ALTER TABLE toque ADD COLUMN avisado TEXT;

-- Para la lista de cumpleaños del inicio.
ALTER TABLE contacto ADD COLUMN nacimiento TEXT CHECK (nacimiento IS NULL OR date(nacimiento) IS nacimiento);

-- Respuestas rápidas: tocar una abre WhatsApp con el texto ya escrito. Variables: {nombre} y {turno}.
CREATE TABLE respuesta (
  id INTEGER PRIMARY KEY,
  titulo TEXT NOT NULL CHECK (trim(titulo) <> ''),
  texto TEXT NOT NULL CHECK (trim(texto) <> ''),
  orden INTEGER NOT NULL DEFAULT 0
);

INSERT INTO respuesta(titulo, texto, orden) VALUES
  ('Confirmar turno', 'Hola {nombre}, te confirmo tu turno: {turno}. ¿Me confirmás que podés venir?', 1),
  ('Retomar contacto', 'Hola {nombre}, ¿cómo andás? Te escribo para saber si pudiste ver lo que charlamos.', 2),
  ('Gracias', 'Hola {nombre}, gracias por tu tiempo. Cualquier cosa que necesites, escribime.', 3);

-- Reglas locales. Dos eventos: una oportunidad pasa a una etapa, o se crea un contacto.
-- Crean una tarea para dentro de `dias` días. No mandan nada: solo agregan la tarea.
CREATE TABLE regla (
  id INTEGER PRIMARY KEY,
  evento TEXT NOT NULL CHECK (evento IN ('etapa', 'contacto_nuevo')),
  etapa_id INTEGER REFERENCES etapa(id) ON DELETE CASCADE,
  texto TEXT NOT NULL CHECK (trim(texto) <> ''),
  dias INTEGER NOT NULL DEFAULT 1 CHECK (dias >= 0 AND dias <= 365),
  activa INTEGER NOT NULL DEFAULT 1 CHECK (activa IN (0, 1)),
  CHECK ((evento = 'etapa') = (etapa_id IS NOT NULL))
);

-- Viene apagada: una actualización no cambia lo que hace la app hasta que el cliente la prenda en Configuración.
INSERT INTO regla(evento, texto, dias, activa) VALUES ('contacto_nuevo', 'Primer contacto', 1, 0);

CREATE INDEX regla_por_etapa ON regla(etapa_id) WHERE activa = 1;

CREATE TRIGGER regla_oportunidad_pasa_a_etapa AFTER UPDATE OF etapa_id ON oportunidad
WHEN NEW.etapa_id <> OLD.etapa_id
BEGIN
  INSERT INTO toque(contacto_id, oportunidad_id, tipo, texto, vence)
  SELECT NEW.contacto_id, NEW.id, 'tarea', r.texto, date('now', 'localtime', '+' || r.dias || ' days')
    FROM regla r WHERE r.evento = 'etapa' AND r.etapa_id = NEW.etapa_id AND r.activa = 1
     -- si la oportunidad va y vuelve a la etapa, no se repite la tarea que todavía está pendiente
     AND NOT EXISTS (SELECT 1 FROM toque t WHERE t.oportunidad_id = NEW.id AND t.tipo = 'tarea' AND t.hecho IS NULL AND t.texto = r.texto);
END;

CREATE TRIGGER regla_contacto_nuevo AFTER INSERT ON contacto
BEGIN
  INSERT INTO toque(contacto_id, oportunidad_id, tipo, texto, vence)
  SELECT NEW.id, NULL, 'tarea', r.texto, date('now', 'localtime', '+' || r.dias || ' days')
    FROM regla r WHERE r.evento = 'contacto_nuevo' AND r.activa = 1;
END;
