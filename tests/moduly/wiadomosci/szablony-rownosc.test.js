import { describe, it, expect } from 'vitest';
import { mailPotwierdzenia, mailPlatniczy } from '../../../src/moduly/wiadomosci/szablony.js';
import { oprawaMaila } from '../../../src/moduly/wiadomosci/oprawa.js';
import { modelWiadomosci } from '../../../src/domena/wiadomosc-platnicza.js';
import { DOMYSLNE } from '../../../src/domena/szablony-wiadomosci.js';

// PRZ-101.03: DOMYŚLNY SZABLON = DZISIEJSZY MAIL CO DO ZNAKU.
//
// Lewa strona: droga bez szablonu (`szablon: null`) — te same funkcje, które składały maile przed PRZ-101
// (trescPotwierdzenia/jakoTekst/renderPotwierdzenieHtml, TEMAT_MAILA/jakoTekstWiadomosci/renderWiadomoscHtml).
// Prawa: silnik szablonów z treścią domyślną. Każda różnica w temacie, tekście albo HTML-u = czerwony test,
// bo znaczy, że „Przywróć domyślny" albo pierwsza edycja zmieniłyby mail, którego operator nie ruszał.

const OPRAWY = [
  oprawaMaila({}),
  oprawaMaila({ podpis: 'Pracownia Półcień', naglowek: 'Pracownia Półcień', footer: 'ul. Lipowa 7, Warszawa\nhttps://example.com' }),
];

const baza = (nad = {}) => ({
  numer: '1024', utworzone_at: '2026-10-14T21:30:00Z', sklep: 'reczne', kwota_brutto: '476.00',
  koszt_dostawy_brutto: '19.00', koszt_dostawy_netto: '15.45', metoda_wysylki: 'dpd', metoda_platnosci: 'Przelew',
  termin_platnosci: '14', pobranie: 0, platnosci: [], chce_fakture: 0, anulowane: 0,
  klient: { email: 'anna.nowak@example.com', phone: '600100200' },
  dostawa: { first_name: 'Anna', last_name: 'Nowak', address_1: 'Lipowa 7', postcode: '00-950', city: 'Warszawa' },
  pozycje: [
    { nazwa: 'Lampa stołowa Grzybek 30 cm', ilosc: 2, cena_brutto: '189.00', brutto_linii: '378.00' },
    { nazwa: 'Klosz lniany <40 cm> & "len"', ilosc: 1, cena_brutto: '79.00', brutto_linii: '79.00' },
  ],
  ...nad,
});

const ZAMOWIENIA = {
  'zwykłe, przelew 14 dni': baza(),
  'z fakturą na firmę': baza({ chce_fakture: 1, klient: { email: 'biuro@example.com', company: 'Półcień sp. z o.o.', first_name: 'Anna', last_name: 'Nowak', address_1: 'Lipowa 7', postcode: '00-950', city: 'Warszawa' }, nip: '1234563218' }),
  'za pobraniem': baza({ pobranie: 1, kwota_pobrania: '476.00', metoda_platnosci: 'Za pobraniem' }),
  'bez adresu dostawy, jedna pozycja': baza({ dostawa: {}, kwota_brutto: '208.00', pozycje: [{ nazwa: 'Kinkiet', ilosc: 1, cena_brutto: '189.00', brutto_linii: '189.00' }] }),
  'opłacone': baza({ oplacone_at: '2026-10-15T08:00:00Z', platnosci: [{ kwota: '476.00', data: '2026-10-15' }] }),
};

const porownaj = (a, b) => {
  expect(b.temat).toBe(a.temat);
  expect(b.tekst).toBe(a.tekst);
  expect(b.html).toBe(a.html);
};

describe('potwierdzenie: domyślny szablon = dzisiejszy mail', () => {
  for (const [nazwa, z] of Object.entries(ZAMOWIENIA)) {
    for (const [i, oprawa] of OPRAWY.entries()) {
      it(`${nazwa} (oprawa ${i})`, () => {
        porownaj(mailPotwierdzenia(z, { oprawa, szablon: null }), mailPotwierdzenia(z, { oprawa, szablon: DOMYSLNE.potwierdzenie }));
      });
    }
  }
});

// Recenzja 18.10: {kwota} to wartość zamówienia; po wpłacie częściowej przypomnienie ma prosić o RESZTĘ — {do_zaplaty}.
describe('{do_zaplaty} po wpłacie częściowej', () => {
  it('zamówienie 476 zł, wpłacone 200 zł: {do_zaplaty} = 276,00 zł, {kwota} = 476,00 zł', () => {
    const z = baza({ platnosci: [{ data: '2026-10-15', kwota: '200.00' }] });
    const oprawa = OPRAWY[0];
    const model = modelWiadomosci(z, { temat_id: 'przypomnienie', rachunek: '00 1111 2222 3333 4444 5555 6666', odbiorca: 'X', dzis: '2026-10-18', podpis: oprawa.podpis });
    const szablon = { temat: 'Dopłata {do_zaplaty}', tresc: 'Prosimy o dopłatę {do_zaplaty} (zamówienie na {kwota}).\n\n{dane_platnosci}\n\n{zamkniecie}\n\n{podpis}' };
    const mail = mailPlatniczy(z, model, { temat_id: 'przypomnienie', oprawa, szablon });
    expect(mail.temat).toBe('Dopłata 276,00 zł');
    expect(mail.tekst).toContain('Prosimy o dopłatę 276,00 zł (zamówienie na 476,00 zł).');
    expect(mail.html).toContain('Prosimy o dopłatę 276,00 zł (zamówienie na 476,00 zł).');
  });

  it('przy pobraniu {do_zaplaty} jest puste — nie ma czego przelewać', () => {
    const z = baza({ pobranie: 1, kwota_pobrania: '476.00' });
    const oprawa = OPRAWY[0];
    const model = modelWiadomosci(z, { temat_id: 'faktura', dokument: { numer: 'FV 1' }, rachunek: '00 1111', odbiorca: 'X', dzis: '2026-10-18', podpis: oprawa.podpis });
    const mail = mailPlatniczy(z, model, { temat_id: 'faktura', dokument: { numer: 'FV 1' }, oprawa,
      szablon: { temat: 'T', tresc: 'Do przelewu: [{do_zaplaty}]\n\n{dane_platnosci}\n\n{zamkniecie}' } });
    expect(mail.tekst).toContain('Do przelewu: []');
    expect(mail.tekst).toContain('kurier');
  });
});

describe('proforma, faktura, przypomnienie: domyślny szablon = dzisiejszy mail', () => {
  const RACHUNEK = '00 1111 2222 3333 4444 5555 6666';
  const warianty = [
    ['proforma', { numer: 'PF 7/10/2026' }, { zalaczonyDokument: true }],
    ['faktura', { numer: 'FV 12/10/2026' }, { zalaczonyDokument: true }],
    ['faktura', { numer: 'FV 13/10/2026' }, { zalaczonyDokument: true, zalacznikWywozu: true }],
    ['przypomnienie', { numer: 'PF 7/10/2026' }, { zalaczonyDokument: true, zalacznikProformy: 'PF 7/10/2026' }],
    ['przypomnienie', null, {}],
  ];
  for (const [nazwa, z] of Object.entries(ZAMOWIENIA)) {
    for (const [temat_id, dokument, koperta] of warianty) {
      for (const rachunek of [RACHUNEK, null]) {
        it(`${temat_id} ${dokument?.numer ?? 'bez dokumentu'} ${JSON.stringify(koperta)} — ${nazwa}, rachunek ${rachunek ? 'jest' : 'brak'}`, () => {
          const oprawa = OPRAWY[1];
          const model = modelWiadomosci(z, { temat_id, dokument, ...koperta, rachunek, odbiorca: 'Pracownia Półcień', dzis: '2026-10-18', podpis: oprawa.podpis });
          porownaj(
            mailPlatniczy(z, model, { temat_id, dokument, oprawa, szablon: null }),
            mailPlatniczy(z, model, { temat_id, dokument, oprawa, szablon: DOMYSLNE[temat_id] }),
          );
        });
      }
    }
  }
});
