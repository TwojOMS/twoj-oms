// Motyw jasny/ciemny. Cala decyzja siedzi tutaj, w czystych funkcjach, bo panel NIE MA
// JavaScriptu (poza przeliczaniem netto/brutto) i przelacznik musi dzialac po stronie
// serwera — tak samo jak filtry i wyszukiwanie chodza przez adres strony.
//
// ⚠️ DLACZEGO CIASTECZKO, A NIE KOLUMNA W BAZIE. To jest preferencja OKA, nie fakt
// o zamowieniach: dwoje ludzi przy dwoch monitorach ma prawo miec rozne ustawienie, a wpis
// w bazie po cichu przestawialby ekran drugiej osobie. Ciasteczko obsluguje sie tu recznie,
// bez `@fastify/cookie`: jedna wartosc, dwa mozliwe stany, dziesiec linii — dokladanie
// zaleznosci do projektu, ktory ma ich jedenascie, byloby nieproporcjonalne.

export const MOTYWY = ['jasny', 'ciemny'];
export const MOTYW_DOMYSLNY = 'jasny';

const NAZWA_CIASTECZKA = 'oms_motyw';

/**
 * Motyw z naglowka `Cookie`. Wszystko, czego nie rozpoznajemy — brak naglowka, obcy motyw,
 * smiec — znaczy motyw DOMYSLNY, nigdy blad: zepsute ciasteczko nie ma prawa wywalic
 * kazdej strony panelu naraz.
 */
export function motywZNaglowka(naglowekCookie) {
  const wpisy = String(naglowekCookie ?? '').split(';');
  for (const wpis of wpisy) {
    const rownosc = wpis.indexOf('=');
    if (rownosc === -1) continue;
    if (wpis.slice(0, rownosc).trim() !== NAZWA_CIASTECZKA) continue;
    const wartosc = wpis.slice(rownosc + 1).trim();
    if (MOTYWY.includes(wartosc)) return wartosc;
  }
  return MOTYW_DOMYSLNY;
}

export const przeciwnyMotyw = (motyw) => (motyw === 'ciemny' ? 'jasny' : 'ciemny');

/**
 * Wartosc naglowka `Set-Cookie`.
 *
 * `HttpOnly`, bo tego ciasteczka nie czyta ani jedna linia JavaScriptu — a skoro nie musi
 * byc widoczne dla skryptow, to nie ma powodu, zeby bylo. `SameSite=Lax` odcina zadanie
 * z obcej strony; `Secure` CELOWO nie ma, bo panel chodzi po LAN-ie po zwyklym http
 * i przegladarka po prostu odrzucilaby takie ciasteczko.
 */
export function ciasteczkoMotywu(motyw) {
  const bezpieczny = MOTYWY.includes(motyw) ? motyw : MOTYW_DOMYSLNY;
  return `${NAZWA_CIASTECZKA}=${bezpieczny}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`;
}

// ⚠️ `bezpiecznyPowrot` PRZEPROWADZILA SIE do src/security/powrot.js (2026-08-09), bo tej
// samej bramki potrzebuje logowanie w OBU panelach. Re-eksport zostaje, zeby kilkanascie
// istniejacych importow nie musialo sie zmieniac — a druga implementacja tej reguly
// rozjechalaby sie z ta przy pierwszej poprawce.
export { bezpiecznyPowrot } from '../core/bezpieczenstwo/powrot.js';
