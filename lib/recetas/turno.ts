/** "jueves 14/11 a las 15:30" — el {{turno}} de las recetas y de las respuestas rápidas. */
import { tagDeIdioma } from "@/lib/i18n/datas";
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMA_PADRAO, type Idioma } from "@/lib/i18n/idiomas";

export function textoDelTurno(
  comienzo: Date,
  timezone: string,
  idioma: Idioma = IDIOMA_PADRAO,
): string {
  const etiqueta = tagDeIdioma(idioma);
  const dia = new Intl.DateTimeFormat(etiqueta, {
    timeZone: timezone,
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
  }).format(comienzo);
  const hora = new Intl.DateTimeFormat(etiqueta, {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(comienzo);
  return `${dia} ${traduzir("às", idioma)} ${hora}`;
}
