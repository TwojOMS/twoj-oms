// Cena sprzedaży z formularza produktu: netto, stawka VAT i brutto → jedna kwota do zapisu.
//
// Ten moduł działa w dwóch miejscach naraz: na serwerze (zapis nowej karty) i w przeglądarce
// (podgląd na żywo — panel serwuje go razem z vat.js i kwota.js pod /public/domena/). Dzięki
// temu formularz nie ma własnej kopii arytmetyki, która mogłaby się rozjechać z zapisem.
// Dlatego tylko czyste funkcje i importy względne, bez niczego z Node.
//
// Przechowujemy WYŁĄCZNIE brutto (`karty_produktow.cena_gr`). Netto to wygoda wejścia —
// ten sam powód, co przy `bruttoZNetto` w vat.js.
import { czyStawkaVat, bruttoGrZNettoGr, nettoGrZBruttoGr } from './vat.js';
import { groszeCenyKatalogowej } from './kwota.js';

export const BRAK_STAWKI = 'Wybierz stawkę VAT albo wpisz cenę brutto.';

const tekst = (wartosc) => (wartosc === null || wartosc === undefined ? '' : String(wartosc).trim());

// Kwota wpisana przez człowieka → grosze; `null` dla pustego pola, `undefined` dla nie-kwoty.
const grosze = (wartosc) => groszeCenyKatalogowej(tekst(wartosc));

const zlotowki = (gr) => (gr / 100).toFixed(2).replace('.', ',');

const nieKwota = (wartosc, jaka) =>
  `„${tekst(wartosc)}” to nie jest cena ${jaka} w złotych. Wpisz samą kwotę (np. 49,90) albo zostaw pole puste.`;

/**
 * @param {{ netto?: string, brutto?: string, stawka?: string }} pola
 * @param {{ zw?: boolean }} [opcje] — „zw” tylko tam, gdzie wołający go dopuszcza.
 * @returns {{ cena_gr: number|null, blad: string|null }} brutto w groszach.
 *
 * Brutto wpisane wygrywa: to ono jedzie na paragon i fakturę, a netto obok bywa nieaktualne.
 * Netto bez stawki nie zgadujemy — 23% „na oko” zapisałoby złą cenę bez śladu.
 */
export function cenaSprzedazyZFormularza({ netto, brutto, stawka } = {}, opcje) {
  if (tekst(brutto) !== '') {
    const gr = grosze(brutto);
    if (gr === undefined) return { cena_gr: null, blad: nieKwota(brutto, 'brutto') };
    return { cena_gr: gr, blad: null };
  }
  if (tekst(netto) === '') return { cena_gr: null, blad: null };
  const gr = grosze(netto);
  if (gr === undefined) return { cena_gr: null, blad: nieKwota(netto, 'netto') };
  if (!czyStawkaVat(stawka, opcje)) return { cena_gr: null, blad: BRAK_STAWKI };
  return { cena_gr: bruttoGrZNettoGr(gr, String(stawka).trim(), opcje), blad: null };
}

/**
 * Pola formularza po zmianie jednego z nich. `zrodlo` to pole wpisane ostatnio ('netto' albo
 * 'brutto'); zmiana stawki przelicza od niego. Bez znacznika liczymy od brutto, bo to ono
 * wygrywa przy zapisie. Pole źródłowe wraca bez zmian, żeby nie poprawiać człowiekowi pisanego tekstu.
 *
 * @returns {{ netto: string, brutto: string }}
 */
export function polaCenyPoZmianie({ netto, brutto, stawka, zrodlo } = {}, opcje) {
  const pola = { netto: tekst(netto) === '' ? '' : String(netto), brutto: tekst(brutto) === '' ? '' : String(brutto) };
  if (!czyStawkaVat(stawka, opcje)) return pola;
  const s = String(stawka).trim();
  const odNetto = zrodlo === 'netto' || (zrodlo !== 'brutto' && tekst(brutto) === '');
  const gr = grosze(odNetto ? netto : brutto);
  if (gr === undefined) return pola;
  if (odNetto) pola.brutto = gr === null ? '' : zlotowki(bruttoGrZNettoGr(gr, s, opcje));
  else pola.netto = gr === null ? '' : zlotowki(nettoGrZBruttoGr(gr, s, opcje));
  return pola;
}

/**
 * Podgląd marży — napis do pokazania, nic się z nim nie zapisuje. Procent liczony od ceny
 * sprzedaży netto (ile z ceny zostaje), nie od zakupu.
 *
 * @returns {string|null} np. „Marża: 2,50 zł netto (25,0%)”; `null`, gdy nie ma z czego liczyć.
 */
export function podgladMarzy({ netto, zakup } = {}) {
  const sprzedaz = grosze(netto);
  const koszt = grosze(zakup);
  if (typeof sprzedaz !== 'number' || typeof koszt !== 'number' || sprzedaz <= 0) return null;
  const marza = sprzedaz - koszt;
  const procentMarzy = (Math.round((marza * 1000) / sprzedaz) / 10).toFixed(1).replace('.', ',');
  return `Marża: ${zlotowki(marza)} zł netto (${procentMarzy}%)`;
}
