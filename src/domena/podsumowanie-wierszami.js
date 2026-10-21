import { czyStawkaVat } from './vat.js';

// PRZ-105 — podsumowanie netto / VAT / brutto pod pozycjami (ekran „Nowe zamówienie”, karta).
//
// ⚠️ TA SAMA REGUŁA, KTÓRĄ LICZY FAKTURA — zmierzona, nie założona. 21.10.2026, 400 ostatnich faktur
// sprzedaży z inFaktu (tylko odczyt): netto linii = round(brutto_linii × 100 / (100 + stawka)) w 968/968
// liniach, netto dokumentu = SUMA netto linii w 270/270 fakturach wielopozycyjnych, VAT = brutto − netto.
//
// To NIE jest reguła proformy (domain/podsumowanie-vat.js liczy od sumy brutto stawki) — tamta zgodziła
// się z fakturą tylko w 149/270 przypadków, w 121 rozjechała o 1–2 gr. Grosz różnicy między ekranem
// a fakturą to błąd, więc ekran liczy jak inFakt, a proforma zostaje swoją sprawą (osobne zadanie).
//
// Kopia dla przeglądarki stoi w public/suma-podglad.js i jest przypięta do tej testem wspólnej tablicy.

/**
 * @param {{ bruttoGr: number, stawka: string|number }[]} linie — linie towarów i dostawy, grosze całkowite
 * @returns {{ nettoGr: number, vatGr: number, bruttoGr: number }}
 */
export function podsumowanieWierszami(linie = []) {
  let nettoGr = 0;
  let bruttoGr = 0;
  linie.forEach((l, i) => {
    if (!Number.isInteger(l?.bruttoGr)) throw new Error(`Linia ${i + 1}: kwota brutto nie w całych groszach („${l?.bruttoGr}”).`);
    if (!czyStawkaVat(l.stawka)) throw new Error(`Linia ${i + 1}: stawka VAT spoza listy („${l.stawka}”).`);
    nettoGr += Math.round((l.bruttoGr * 100) / (100 + Number(l.stawka)));
    bruttoGr += l.bruttoGr;
  });
  return { nettoGr, vatGr: bruttoGr - nettoGr, bruttoGr };
}
