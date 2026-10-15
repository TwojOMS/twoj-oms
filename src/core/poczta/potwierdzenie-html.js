import { KOLOR, FONT, esc, kopertaMaila, naglowekSekcji as naglowek } from './mail-html.js';

// POTWIERDZENIE PRZYJĘCIA ZAMÓWIENIA — postać HTML (21.08.2026, zgłoszenie właściciela:
// „popraw maila, wygląda słabo: pozycje jako tabela, dodaj nagłówki, FAKTURA: tak + dane").
//
// ⚠️ TEN PLIK NIC NIE LICZY. Dostaje MODEL złożony raz przez domenę
// (oms/domain/potwierdzenie-zamowienia.js: `modelPotwierdzenia`) i wyłącznie go układa.
// Kwoty, etykiety i decyzje o tym, co pokazać, zapadły tam — bo dokładnie te same wartości
// idą do zapasowej wersji tekstowej TEJ SAMEJ wiadomości. Mail multipart, w którym tabela
// pokazuje co innego niż tekst, byłby gorszy niż brak tabeli.
//
// ⚠️ KOPERTA WSPÓLNA Z MAILAMI WYCENY (`kopertaMaila`) — jeden papier firmowy na całą
// korespondencję panelu. Paleta i font stamtąd, nie z własnej kopii.
//
// ZASADY POCZTY, których tu przestrzegamy, bo klienty pocztowe nie są przeglądarkami:
//   • układ na TABELACH, nie na flex/grid — Outlook nie zna ani jednego, ani drugiego;
//   • style WYŁĄCZNIE inline — Gmail i Outlook wycinają <style> z <head>;
//   • font systemowy — webfontów nikt nie załaduje;
//   • żadnych obrazków dla treści — połowa klientów blokuje je domyślnie.

const kom = (extra = '') => `padding:8px 4px;border-bottom:1px solid ${KOLOR.linia};`
  + `font-family:${FONT};font-size:14px;color:${KOLOR.tekst};${extra}`;

// ⚠️ NAGŁÓWEK SEKCJI IMPORTOWANY Z `mail-html.js` pod nazwą `naglowek` (sprzątanie po recenzji
// całości gałęzi, 22.08.2026). Do tego dnia stał tu przepisany znak w znak — a drugą, taką
// samą kopię miał wiadomosc-html.js. Krój jest BLISKI, ale nie identyczny z nagłówkiem
// w mailach z wyceną (`renderMailHtml`): tamten ma rozstrzelenie 2px i obcina dwukropek,
// bo rozpoznaje nagłówek we wpisanym przez człowieka tekście. Uzasadnienie przy funkcji.

/** Blok linii (adres, dane nabywcy) — jedna linia pod drugą, bez ozdobników. */
const linie = (lista) => `<p style="margin:0 0 4px;font-family:${FONT};font-size:14px;`
  + `line-height:1.6;color:${KOLOR.tekst};">${lista.map((l) => esc(l)).join('<br>')}</p>`;

/**
 * Tabela pozycji.
 *
 * ⚠️ ILOŚĆ, CENA I SUMA MAJĄ WŁASNE KOLUMNY — o to była prośba i to jest cała różnica wobec
 * poprzedniej wersji, w której wszystko stało w jednej linii tekstu rozdzielone myślnikami.
 * Kolumny liczbowe do PRAWEJ i `white-space:nowrap`, żeby kwota nie łamała się na pół przy
 * wąskim ekranie telefonu.
 *
 * ⚠️ Wiersz „Razem" jest częścią TEJ SAMEJ tabeli, a nie osobnym akapitem pod nią: inaczej
 * przy wąskiej szerokości suma odjeżdża od kolumny, w której klient jej szuka.
 */
function tabelaPozycji(m) {
  const naglowki = ['Pozycja', 'Ilość', 'Cena', 'Wartość'];
  const wiersze = m.pozycje.map((p) => `<tr>`
    + `<td style="${kom()}">${esc(p.nazwa)}</td>`
    + `<td align="right" style="${kom('white-space:nowrap;')}">${esc(p.ilosc)}</td>`
    + `<td align="right" style="${kom('white-space:nowrap;')}">${esc(p.cena)}</td>`
    + `<td align="right" style="${kom('white-space:nowrap;')}">${esc(p.suma)}</td>`
    + '</tr>').join('');

  const razem = `padding-top:10px;border-bottom:0;border-top:2px solid ${KOLOR.akcent};font-weight:bold;`;
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"'
    + ' style="border-collapse:collapse;margin:2px 0 4px;">'
    + `<tr>${naglowki.map((n, i) => `<td${i ? ' align="right"' : ''} style="${kom(
      `font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:${KOLOR.muted};`,
    )}">${esc(n)}</td>`).join('')}</tr>`
    + wiersze
    + `<tr><td colspan="3" style="${kom(razem)}">Razem brutto</td>`
    + `<td align="right" style="${kom(`${razem}white-space:nowrap;`)}">${esc(m.razem)}</td></tr>`
    + '</table>';
}

/** Akapit zwykłego zdania — ten sam rozmiar, co w mailach z wyceną. */
const akapit = (tekst, extra = '') => `<p style="margin:0 0 14px;font-family:${FONT};font-size:15px;`
  + `line-height:1.6;color:${KOLOR.tekst};${extra}">${esc(tekst)}</p>`;

export function renderPotwierdzenieHtml(m, { footer = '', naglowek: naglowekMarki = '' } = {}) {
  const body = [
    akapit('Dzień dobry,'),
    akapit(`potwierdzamy przyjęcie zamówienia nr ${m.numer} z dnia ${m.dzien}.`),

    naglowek('Zamówienie'),
    tabelaPozycji(m),

    naglowek('Płatność'),
    linie([m.platnosc]),

    naglowek('Wysyłka'),
    // Adres wychodzi POD metodą i drobniejszym drukiem — to metoda jest odpowiedzią na
    // pytanie „jak to do mnie dojedzie", a adres jej uzupełnieniem.
    linie([m.wysylka.metoda]),
    m.wysylka.adres
      ? `<p style="margin:0 0 4px;font-family:${FONT};font-size:14px;line-height:1.6;color:${KOLOR.muted};">`
        + `${m.wysylka.adres.map((l) => esc(l)).join('<br>')}</p>`
      : `<p style="margin:0 0 4px;font-family:${FONT};font-size:14px;color:${KOLOR.muted};">`
        + 'adres do uzgodnienia</p>',

    naglowek('Faktura'),
    ...(m.faktura.chce
      ? [
        linie(['Tak — wystawimy na:']),
        `<p style="margin:0 0 4px;font-family:${FONT};font-size:14px;line-height:1.6;color:${KOLOR.muted};">`
          + `${(m.faktura.linie.length ? m.faktura.linie : ['dane do uzgodnienia']).map((l) => esc(l)).join('<br>')}</p>`,
      ]
      : [linie(['Nie'])]),

    `<p style="margin:22px 0 14px;font-family:${FONT};font-size:14px;line-height:1.6;color:${KOLOR.muted};`
      + `border-top:1px solid ${KOLOR.linia};padding-top:14px;">`
      + 'Jeśli coś się nie zgadza, wystarczy odpowiedzieć na tego maila.</p>',
    akapit('Pozdrawiamy,', 'margin-bottom:2px;'),
    akapit(m.sprzedawca, 'font-weight:bold;'),
  ].join('');

  return kopertaMaila({ body, footer, naglowek: naglowekMarki });
}
