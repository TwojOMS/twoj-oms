import { KOLOR, FONT, MONO, esc, kopertaMaila, naglowekSekcji } from './mail-html.js';

// WIADOMOŚCI Z DOKUMENTEM ALBO O PIENIĄDZACH — postać HTML (22.08.2026): proforma, faktura,
// przypomnienie o płatności.
//
// ⚠️ TEN PLIK NIC NIE LICZY. Dostaje MODEL złożony raz przez domenę
// (`oms/domain/wiadomosc-platnicza.js`: `modelWiadomosci`) i wyłącznie go układa. Dokładnie
// te same wartości idą do zapasowej wersji tekstowej TEJ SAMEJ wiadomości — mail multipart,
// w którym tabela pokazuje co innego niż tekst, byłby gorszy niż brak tabeli.
//
// ⚠️ KOPERTA WSPÓLNA (`kopertaMaila`) — jeden papier firmowy na całą korespondencję panelu:
// wycena, potwierdzenie przyjęcia i te trzy. Paleta i font stamtąd, nigdy z własnej kopii.
//
// ZASADY POCZTY (klienty pocztowe nie są przeglądarkami):
//   • układ na TABELACH, nie na flex/grid — Outlook nie zna ani jednego, ani drugiego;
//   • style WYŁĄCZNIE inline — Gmail i Outlook wycinają <style> z <head>;
//   • font systemowy, żadnych obrazków dla treści.

const akapit = (tekst, extra = '') => `<p style="margin:0 0 14px;font-family:${FONT};font-size:15px;`
  + `line-height:1.6;color:${KOLOR.tekst};${extra}">${esc(tekst)}</p>`;

// ⚠️ `naglowekSekcji` IMPORTOWANY Z `mail-html.js`, NIE PRZEPISANY TUTAJ (sprzątanie po
// recenzji całości gałęzi, 22.08.2026). Do tego dnia stał tu i w potwierdzeniu przyjęcia
// zamówienia dwa razy, znak w znak — a dwie kopie tego samego stylu rozjeżdżają się przy
// pierwszej poprawce palety. Uzasadnienie kroju i tego, dlaczego wersja z `renderMailHtml`
// zostaje osobno, stoi przy funkcji w mail-html.js.

// Kwota do zapłaty jest NAJWIĘKSZĄ liczbą w tym mailu i to jest cały powód osobnego stylu:
// klient otwiera taką wiadomość po to, żeby zobaczyć, ile ma przelać.
const kwota = (tekst) => `<p style="margin:0 0 4px;font-family:${FONT};font-size:22px;font-weight:bold;`
  + `line-height:1.4;color:${KOLOR.tekst};">${esc(tekst)} `
  + `<span style="font-size:14px;font-weight:normal;color:${KOLOR.muted};">brutto</span></p>`;

const komorkaK = `padding:7px 4px;border-bottom:1px solid ${KOLOR.linia};font-family:${FONT};`
  + `font-size:12px;letter-spacing:.3px;color:${KOLOR.muted};white-space:nowrap;`;
const komorkaW = `padding:7px 4px;border-bottom:1px solid ${KOLOR.linia};font-family:${FONT};`
  + `font-size:14px;color:${KOLOR.tekst};`;

const wiersz = (klucz, wartosc, extra = '') => `<tr><td style="${komorkaK}">${esc(klucz)}</td>`
  + `<td style="${komorkaW}${extra}">${esc(wartosc)}</td></tr>`;

// Numer rachunku klient PRZEPISUJE do banku — w czcionce proporcjonalnej cyfry zlewają się
// w jeden ciąg. TA SAMA reguła i to samo uzasadnienie, co przy numerze konta w treściach
// wyceny (src/mail/mail-html.js: `liniaPudelka`/`RE_NUMER_KONTA`; recenzja 22.08.2026 —
// tabela tutaj cytowała to uzasadnienie w komentarzu, ale robiła odwrotnie).
//
// ⚠️ STAŁA `MONO` Z `mail-html.js`, NIE DRUGI LITERAŁ (sprzątanie 22.08.2026): ten sam napis
// stał wprost w dwóch plikach, a lista krojów zapasowych to rzecz, którą poprawia się w obu
// naraz albo w żadnym.

/**
 * Tabela danych do przelewu.
 *
 * ⚠️ TABELA, A NIE AKAPIT: te cztery wartości klient PRZEPISUJE do banku, więc muszą stać
 * w kolumnach i nie mogą się zlewać. Tytuł przelewu wytłuszczony — to jedyne pole, którego
 * pominięcie sprawia, że przelew przychodzi i nikt nie wie, czego dotyczy.
 */
function tabelaPrzelewu(p) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" `
    + `style="border-collapse:collapse;margin:2px 0 4px;">`
    + wiersz('Odbiorca', p.odbiorca)
    + wiersz('Rachunek', p.rachunek, MONO)
    + wiersz('Tytuł przelewu', p.tytul, 'font-weight:bold;')
    + (p.termin ? wiersz('Termin', p.termin) : '')
    + '</table>';
}

export function renderWiadomoscHtml(m, { footer = '', naglowek: naglowekMarki = '' } = {}) {
  const body = [
    akapit('Dzień dobry,'),
    akapit(m.wiodace),
    ...(m.platnosc ? [
      naglowekSekcji('Do zapłaty'),
      kwota(m.platnosc.doZaplaty),
      naglowekSekcji('Przelew'),
      tabelaPrzelewu(m.platnosc),
    ] : []),
    ...(m.zdanieDokumentu ? [
      `<p style="margin:14px 0 4px;font-family:${FONT};font-size:14px;line-height:1.6;`
        + `color:${KOLOR.tekst};">${esc(m.zdanieDokumentu)}</p>`,
    ] : []),
    ...(m.zdanieWywozu ? [
      `<p style="margin:14px 0 4px;font-family:${FONT};font-size:14px;line-height:1.6;`
        + `color:${KOLOR.tekst};">${esc(m.zdanieWywozu)}</p>`,
    ] : []),
    `<p style="margin:22px 0 14px;font-family:${FONT};font-size:14px;line-height:1.6;`
      + `color:${KOLOR.muted};border-top:1px solid ${KOLOR.linia};padding-top:14px;">${esc(m.zamkniecie)}</p>`,
    akapit('Pozdrawiamy,', 'margin-bottom:2px;'),
    akapit(m.sprzedawca, 'font-weight:bold;'),
  ].join('');

  return kopertaMaila({ body, footer, naglowek: naglowekMarki });
}
