import { KOLOR, FONT, esc, naglowekSekcji } from './mail-html.js';

// MAIL „ZAMÓWIENIE WYSŁANE" — blok `{przesylki}` w HTML-u (PRZ-102.21). Model liczy domena
// (`domena/wiadomosc-wyslane.js`: `modelWyslane`) — ten sam, z którego idą linie wersji tekstowej.
//
// ⚠️ ESCAPOWANE WSZYSTKO, TAKŻE ADRES W `href`. Numer listu bywa wpisany z ręki, a wzorzec przewoźnika może
// mieć `&` (DPD w zakładce Przesyłki ma `?typ=1&p1=`) — `esc` jest tu jedyną obroną atrybutu, nie
// `encodeURIComponent` po stronie wzorca.

const linia = (html, extra = '') => `<p style="margin:0 0 4px;font-family:${FONT};font-size:14px;`
  + `line-height:1.6;color:${KOLOR.tekst};${extra}">${html}</p>`;

export function blokiHtmlWyslane(m) {
  const paczki = m.przesylki.map((p) => linia(`${esc(p.przewoznik)}, numer listu: <b>${esc(p.numer)}</b>`
    + (p.link ? `<br><a href="${esc(p.link)}" style="color:${KOLOR.akcent};">Śledź przesyłkę</a>` : ''), 'margin-bottom:10px;'));
  const punkt = m.punkt ? linia(`Punkt odbioru: ${esc(m.punkt)}`, `color:${KOLOR.muted};`) : '';
  return { przesylki: naglowekSekcji(m.przesylki.length > 1 ? 'Przesyłki' : 'Przesyłka') + paczki.join('') + punkt };
}
