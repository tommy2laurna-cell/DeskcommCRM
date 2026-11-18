/**
 * Marca de «este request lo armó la app, no vino de afuera».
 *
 * El formulario público (`/api/v1/captar/publico/[slug]`) valida, aplica antispam y
 * consentimiento, y recién ahí le pasa el envío a `/webhooks/in/<token>` dentro del mismo
 * proceso. Si esa URL aceptara también tráfico externo, cualquiera que lea el `path_token`
 * (M4: lo ve todo miembro de la org, viewer incluido) se saltearía casilla, señuelo y límite
 * por IP. Una cabecera no sirve de marca (se falsifica); la identidad del objeto, sí: un
 * request de red nunca está en este conjunto.
 */
const INTERNOS = new WeakSet<Request>();

export function marcarReenvioInterno(req: Request): Request {
  INTERNOS.add(req);
  return req;
}

export function esReenvioInterno(req: Request): boolean {
  return INTERNOS.has(req);
}
