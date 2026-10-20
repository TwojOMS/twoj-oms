// PRZ-102.17: scenariusze maili o płatności — każdy wariant zdania zamykającego i każde zdanie bloku {dane_platnosci}.
// Jedno źródło dla testu „bajt w bajt” (tests/moduly/wiadomosci/zdania-platnosci-rownosc-prz102-17.test.js) i dla
// skryptu, który przed zmianą zapisał wzorzec (tests/fixtures/zdania-platnosci-prz102-17.json). Dane zmyślone.

export const OPRAWA = Object.freeze({ podpis: 'Pracownia Półcień', naglowek: 'Pracownia Półcień', footer: 'ul. Fikcyjna 1, 00-001 Testowo' });

const RACHUNEK = '00 1111 2222 3333 4444 5555 6666';

const zam = (nad = {}) => ({
  numer: 'T/2026/017', utworzone_at: '2026-10-14T09:15:00', kwota_brutto: '476.00',
  metoda_wysylki: 'dpd', pobranie: 0, platnosci: [], termin_platnosci: '14',
  klient: { first_name: 'Anna', last_name: 'Testowa', email: 'anna@pracownia.example.test' },
  dostawa: { first_name: 'Anna', last_name: 'Testowa', address_1: 'Fikcyjna 1', postcode: '00-001', city: 'Testowo' },
  pozycje: [{ zrodlo_id: 1, nazwa: 'Lampa stołowa Grzybek', ilosc: 2, cena_brutto: '238.00', brutto_linii: '476.00' }],
  koszt_dostawy_brutto: '0.00', ...nad,
});

const wspolne = { rachunek: RACHUNEK, odbiorca: 'Pracownia Półcień', dzis: '2026-10-20', podpis: OPRAWA.podpis };
const PF = { numer: 'PF 7/10/2026' };
const FV = { numer: 'FV 12/10/2026' };

/** `[nazwa, { z, opcje, dokument }]` — `opcje` idą do `modelWiadomosci` (bez `zdania`). */
export const SCENARIUSZE = Object.freeze([
  ['proforma do zapłaty', { z: zam(), dokument: PF, opcje: { ...wspolne, temat_id: 'proforma', dokument: PF, zalaczonyDokument: true } }],
  ['faktura do zapłaty', { z: zam(), dokument: FV, opcje: { ...wspolne, temat_id: 'faktura', dokument: FV, zalaczonyDokument: true } }],
  ['przypomnienie z proformą w załączniku', { z: zam(), dokument: PF, opcje: { ...wspolne, temat_id: 'przypomnienie', dokument: PF, zalacznikProformy: PF.numer, zalaczonyDokument: true } }],
  ['przypomnienie bez załącznika', { z: zam(), dokument: null, opcje: { ...wspolne, temat_id: 'przypomnienie' } }],
  ['faktura za pobraniem', { z: zam({ pobranie: 1, kwota_pobrania: '476.00' }), dokument: FV, opcje: { ...wspolne, temat_id: 'faktura', dokument: FV, zalaczonyDokument: true } }],
  ['faktura opłacona', { z: zam({ platnosci: [{ data: '2026-10-15', kwota: '476.00' }] }), dokument: FV, opcje: { ...wspolne, temat_id: 'faktura', dokument: FV, zalaczonyDokument: true } }],
  ['faktura bez rachunku, z załącznikiem', { z: zam(), dokument: FV, opcje: { ...wspolne, rachunek: '', temat_id: 'faktura', dokument: FV, zalaczonyDokument: true } }],
  ['przypomnienie bez rachunku, bez załącznika', { z: zam(), dokument: null, opcje: { ...wspolne, rachunek: '', temat_id: 'przypomnienie' } }],
  ['faktura z błędem wyceny', { z: zam({ pozycje: [{ zrodlo_id: 1, nazwa: 'Zepsuta pozycja', ilosc: 1, cena_brutto: '', brutto_linii: null }] }), dokument: FV, opcje: { ...wspolne, temat_id: 'faktura', dokument: FV, zalaczonyDokument: true } }],
  ['faktura WDT z potwierdzeniem wywozu', { z: zam(), dokument: FV, opcje: { ...wspolne, temat_id: 'faktura', dokument: FV, zalacznikWywozu: true, zalaczonyDokument: true } }],
]);

// ——— PRZ-102.19: maile z blokami zamówienia i z podpisem ————————————————————————————————————————————————
// Potwierdzenie (droga bez szablonu i szablon domyślny), szablon własny ze wszystkimi blokami zamówienia,
// „Zamówienie wysłane" i tekst do wątku Allegro — każdy wariant stałego tekstu (nagłówki sekcji, kolumny tabeli,
// „Razem brutto", „/szt", „Tak — wystawimy na:", „dane do uzgodnienia", „Nie", „(adres do uzgodnienia)",
// „do uzgodnienia" przy braku metody płatności, „Pozdrawiamy,"). Wzorzec: klucze „zamówienie: …" w tym samym
// pliku tests/fixtures/zdania-platnosci-prz102-17.json.

/** Szablon własny ze wszystkimi blokami zamówienia — te same bloki idą do wątku Allegro. */
export const WLASNY = Object.freeze({
  id: 'wlasny-1', nazwa: 'Opóźnienie wysyłki', temat: 'Zamówienie {numer_zamowienia} — opóźnienie',
  tresc: 'Dzień dobry {imie},\n\nzamówienie {numer_zamowienia} wyślemy w poniedziałek.\n\n{pozycje}\n\n{wysylka}\n\n{dane_do_faktury}\n\nW razie pytań wystarczy odpowiedzieć.\n\n{podpis}',
});

const zamPotw = (nad = {}) => zam({
  metoda_platnosci: 'Przelew', chce_fakture: 0, anulowane: 0, koszt_dostawy_brutto: '19.00', koszt_dostawy_netto: '15.45',
  kwota_brutto: '495.00',
  pozycje: [
    { zrodlo_id: 1, nazwa: 'Lampa stołowa Grzybek', ilosc: 2, cena_brutto: '189.00', brutto_linii: '378.00' },
    { zrodlo_id: 2, nazwa: 'Klosz lniany <40 cm> & "len"', ilosc: 1, cena_brutto: '98.00', brutto_linii: '98.00' },
  ],
  przesylki: [{ kurier: 'dpd', status: 'nadana', numer_listu: '0000123456789U' }],
  ...nad,
});

/** `[nazwa, z]` — każde zamówienie przechodzi przez wszystkie rodzaje maili z blokami zamówienia. */
export const SCENARIUSZE_ZAMOWIENIA = Object.freeze([
  ['zamówienie: przelew 14 dni, bez faktury', zamPotw()],
  ['zamówienie: faktura na firmę', zamPotw({ chce_fakture: 1, nip: '1234563218',
    klient: { email: 'biuro@pracownia.example.test', company: 'Pracownia Testowa', first_name: 'Anna', last_name: 'Testowa', address_1: 'Fikcyjna 1', postcode: '00-001', city: 'Testowo' } })],
  ['zamówienie: faktura bez danych nabywcy', zamPotw({ chce_fakture: 1, klient: { email: 'anna@pracownia.example.test' } })],
  ['zamówienie: za pobraniem', zamPotw({ pobranie: 1, kwota_pobrania: '495.00', metoda_platnosci: 'Za pobraniem', termin_platnosci: '' })],
  ['zamówienie: bez adresu dostawy', zamPotw({ dostawa: {} })],
  ['zamówienie: bez metody płatności i terminu', zamPotw({ metoda_platnosci: '', termin_platnosci: '' })],
]);
