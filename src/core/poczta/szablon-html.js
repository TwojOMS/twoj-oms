import { KOLOR, FONT, esc, kopertaMaila } from './mail-html.js';
import { DOMYSLNE_ZDANIA } from '../../domena/zdania-platnosci.js';

// MAIL ZE SZABLONU — postać HTML (PRZ-101.03). Dostaje CZĘŚCI złożone przez domenę
// (`domena/szablony-wiadomosci.js`: `zlozTresc`) i bloki HTML policzone przez renderery tematów
// (potwierdzenie-html.js: `blokiHtmlPotwierdzenia`, wiadomosc-html.js: `blokiHtmlWiadomosci`).
//
// Style akapitu, zdania zamykającego i podpisu są TE SAME, co w dzisiejszych mailach — domyślny szablon
// renderuje się znak w znak jak `renderPotwierdzenieHtml`/`renderWiadomoscHtml` (test równości).
// Zasady poczty jak tam: tabele, style inline, font systemowy.

const linieHtml = (linie) => linie.map((l) => esc(l)).join('<br>');

const akapit = (linie, extra = '') => `<p style="margin:0 0 14px;font-family:${FONT};font-size:15px;`
  + `line-height:1.6;color:${KOLOR.tekst};${extra}">${linieHtml(linie)}</p>`;

// Akapit tuż nad podpisem — dzisiejsze zdanie zamykające: drobniej, wyszarzone, z kreską nad sobą.
const zamkniecie = (linie) => `<p style="margin:22px 0 14px;font-family:${FONT};font-size:14px;line-height:1.6;`
  + `color:${KOLOR.muted};border-top:1px solid ${KOLOR.linia};padding-top:14px;">${linieHtml(linie)}</p>`;

/** Blok `{podpis}`: „Pozdrawiamy," (od PRZ-102.19 z Ustawień → Szablony wiadomości) i marka. */
export const podpisHtml = (sprzedawca, pozdrowienie = DOMYSLNE_ZDANIA.pozdrowienie) => akapit([pozdrowienie], 'margin-bottom:2px;')
  + akapit([sprzedawca], 'font-weight:bold;');

/**
 * `czesci` — z `zlozTresc`; `bloki` — { nazwa: html } dla bloków użytych w treści.
 * Blok bez HTML-u (nie powinien się zdarzyć — domena wpuszcza tylko bloki danego szablonu) wychodzi
 * jako swoje linie tekstu w akapicie, nie znika po cichu.
 */
export function renderSzablonHtml(czesci, bloki, { footer = '', naglowek = '' } = {}) {
  const body = czesci.map((c, i) => {
    if (c.typ === 'blok') return bloki[c.nazwa] ?? akapit(c.linie);
    const nastepna = czesci[i + 1];
    return nastepna?.typ === 'blok' && nastepna.nazwa === 'podpis' ? zamkniecie(c.linie) : akapit(c.linie);
  }).join('');
  return kopertaMaila({ body, footer, naglowek });
}
