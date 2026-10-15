import { describe, it, expect } from 'vitest';
import { paryKorekty } from '../../src/domena/korekta-pozycje.js';

// „Przed" pochodzi Z INFAKTU, nie z zamowienia — patrz komentarz w module.
const faktura = () => ({
  number: 'FV 1/08/2026', invoice_date: '2026-08-01',
  services: [
    { name: 'Kot 70x100', quantity: 2, gross_price: 19800, tax_symbol: '23' },
    { name: 'Dostawa', quantity: 1, gross_price: 1900, tax_symbol: '23' },
  ],
});

// ⚠️ KSZTALT ZMIERZONY, NIE Z DOKUMENTACJI (notatka 2026-08-14-oms-zwroty-pomiar.md).
// Para to DWA WIERSZE o tym samym `group`, rozroznione flaga `correction`:
// `false` = stan PRZED, `true` = stan PO. Pol `quantity_before_correction` NIE MA.
describe('pary przed/po', () => {
  it('kazda pozycja daje DWA wiersze o wspolnym `group`, rozroznione flaga `correction`', () => {
    const { services, blad } = paryKorekty(faktura(), {
      kwota: '99.00', kwota_dostawy: null,
      pozycje: [{ nazwa: 'Kot 70x100', ilosc: 1, kwota: '99.00' }],
    });
    expect(blad).toBeNull();
    expect(services).toHaveLength(4);
    expect(services[0]).toEqual({
      name: 'Kot 70x100', quantity: 2, gross_price: 19800, tax_symbol: '23', group: 1, correction: false,
    });
    expect(services[1]).toEqual({
      name: 'Kot 70x100', quantity: 1, gross_price: 9900, tax_symbol: '23', group: 1, correction: true,
    });
    // Pozycja NIETKNIETA tez musi wystapic w parze — korekta opisuje CALY dokument.
    expect(services[2]).toMatchObject({ name: 'Dostawa', quantity: 1, gross_price: 1900, group: 2, correction: false });
    expect(services[3]).toMatchObject({ name: 'Dostawa', quantity: 1, gross_price: 1900, group: 2, correction: true });
  });

  it('zwrot SAMEJ dostawy zeruje wiersz „po” przy dostawie', () => {
    const { services } = paryKorekty(faktura(), {
      kwota: '0.00', kwota_dostawy: '19.00', pozycje: [],
    });
    expect(services[2]).toMatchObject({ name: 'Dostawa', gross_price: 1900, correction: false });
    expect(services[3]).toMatchObject({ name: 'Dostawa', gross_price: 0, quantity: 0, correction: true });
  });

  it('ODMAWIA, gdy pozycji zwrotu NIE MA na fakturze — zamiast po cichu podstawic', () => {
    const { services, blad } = paryKorekty(faktura(), {
      kwota: '50.00', kwota_dostawy: null,
      pozycje: [{ nazwa: 'Sowa 30x40', ilosc: 1, kwota: '50.00' }],
    });
    expect(services).toBeNull();
    expect(blad).toMatch(/Sowa 30x40/);
  });

  it('ODMAWIA zwrotu wiecej sztuk, niz stoi na fakturze', () => {
    const { blad } = paryKorekty(faktura(), {
      kwota: '297.00', kwota_dostawy: null,
      pozycje: [{ nazwa: 'Kot 70x100', ilosc: 3, kwota: '297.00' }],
    });
    expect(blad).toMatch(/faktur/i);
  });
});

// ⚠️ Fikstura wyzej ma dwie ROZNE nazwy, wiec na te regule byla slepa. Tu nazwa sie POWTARZA.
// Dwie linie o tej samej nazwie powstaja normalnie: ten sam produkt kupiony dwoma pozycjami
// w Woo, dwa `lineItems` na te sama oferte w Allegro, pozycja dopisana recznie o nazwie
// identycznej ze sklepowa.
describe('faktura ze ZDUBLOWANA nazwa pozycji', () => {
  // Bez tej reguly zwrot JEDNEJ sztuki zerowal OBIE linie (mapa `zwracane` jest kluczowana
  // nazwa, a petla po pozycjach siegala do tego samego kubelka przy kazdej linii): korekta na
  // 198,00 zl zamiast 99,00 zl i ANI JEDNEGO ostrzezenia. Bariera „ilosc > iloscPrzed" tego
  // nie lapala, bo liczy per linia.
  const zDwiemaLiniami = () => ({
    number: 'FV 2/08/2026', invoice_date: '2026-08-02',
    services: [
      { name: 'Kot 70x100', quantity: 1, gross_price: 9900, tax_symbol: '23' },
      { name: 'Kot 70x100', quantity: 1, gross_price: 9900, tax_symbol: '23' },
    ],
  });

  it('ODMAWIA zamiast zerowac OBIE linie przy zwrocie jednej sztuki', () => {
    const { services, blad } = paryKorekty(zDwiemaLiniami(), {
      kwota: '99.00', kwota_dostawy: null,
      pozycje: [{ nazwa: 'Kot 70x100', ilosc: 1, kwota: '99.00' }],
    });
    expect(services).toBeNull();
    expect(blad).toMatch(/Kot 70x100/);
    expect(blad).toMatch(/tej samej nazwie/i);
    expect(blad).toMatch(/ręcznie/i);
  });

  // Odmowa jest SWIADOMYM wyborem zamiast sprytnego rozdzielania sztuk po liniach:
  // rozdzielanie zgadywaloby, ktora linie klient zwrocil, a mylna korekta jest gorsza
  // niz jej brak. Dlatego odmawiamy TAKZE wtedy, gdy zwrot dotyczy innej pozycji.
  it('ODMAWIA takze wtedy, gdy zwrot dotyczy pozycji spoza zdublowanej pary', () => {
    const f = zDwiemaLiniami();
    f.services.push({ name: 'Dostawa', quantity: 1, gross_price: 1900, tax_symbol: '23' });
    const { services, blad } = paryKorekty(f, { kwota: '0.00', kwota_dostawy: '19.00', pozycje: [] });
    expect(services).toBeNull();
    expect(blad).toMatch(/tej samej nazwie/i);
  });
});

// I1: pozycja zwrotu, ktorej NIE MA na fakturze, dostaje odmowe z nazwa — a dostawa
// nie dostawala NIC. Faktura bez linii „Dostawa" + `kwota_dostawy` konczyla sie korekta
// BEZ tych pieniedzy i bez sladu: raport zdejmowal 19 zl, korekta nie.
describe('zwrot dostawy przy fakturze BEZ pozycji „Dostawa”', () => {
  const bezDostawy = () => ({
    number: 'FV 3/08/2026', invoice_date: '2026-08-03',
    services: [{ name: 'Kot 70x100', quantity: 2, gross_price: 19800, tax_symbol: '23' }],
  });

  it('ODMAWIA, zamiast po cichu zgubic zwrocona dostawe', () => {
    const { services, blad } = paryKorekty(bezDostawy(), {
      kwota: '0.00', kwota_dostawy: '19.00', pozycje: [],
    });
    expect(services).toBeNull();
    expect(blad).toMatch(/[Dd]ostaw/);
    expect(blad).toMatch(/FV 3\/08\/2026/);
  });

  it('NIE odmawia, gdy zwrotu dostawy nie ma (pole puste albo zerowe)', () => {
    expect(paryKorekty(bezDostawy(), {
      kwota: '99.00', kwota_dostawy: null,
      pozycje: [{ nazwa: 'Kot 70x100', ilosc: 1, kwota: '99.00' }],
    }).blad).toBeNull();
    expect(paryKorekty(bezDostawy(), {
      kwota: '99.00', kwota_dostawy: '0.00',
      pozycje: [{ nazwa: 'Kot 70x100', ilosc: 1, kwota: '99.00' }],
    }).blad).toBeNull();
  });
});

// ⚠️⚠️ DWA ZRODLA DLA JEDNEJ LINII (recenzja kontrolna 2026-08-15). Zwracana POZYCJA moze
// nazywac sie dokladnie „Dostawa" — bo tak nazywa sie pozycja faktury, a operator zaznaczyl ja
// w tabeli zwrotu — i JEDNOCZESNIE moze byc wpisana kwota zwrotu dostawy. Galaz dostawy liczyla
// wtedy `bruttoPo` OD NOWA, nadpisujac kwote policzona z pozycji: kwota na dokumencie
// rozjezdzala sie z kwota zwrotu w panelu PO CICHU. Odmowa jest tu tym samym wyborem, co przy
// zdublowanej nazwie: zsumowanie zgadywaloby, czy to sa te same pieniadze policzone dwa razy,
// czy dwie rozne kwoty — a mylna korekta jest gorsza niz jej brak.
describe('zwracana pozycja o nazwie „Dostawa" RAZEM ze zwrotem kosztu dostawy', () => {
  it('ODMAWIA zamiast po cichu nadpisac kwote policzona z pozycji', () => {
    const { services, blad } = paryKorekty(faktura(), {
      kwota: '19.00', kwota_dostawy: '19.00',
      pozycje: [{ nazwa: 'Dostawa', ilosc: 1, kwota: '19.00' }],
    });
    expect(services).toBeNull();
    expect(blad).toMatch(/[Dd]ostaw/);
    expect(blad).toMatch(/dwa razy|dwóch miejscach|dwa miejsca/i);
  });

  // DROBIAZG 2 (recenzja 2026-08-15): dopoki PIENIEDZY NIE ODDANO, zwrot da sie skasowac
  // (`usunZwrot`, domain/zwrot.js: `powodOdmowyUsunieciaZwrotu` — pieniadze to jedyna bariera)
  // i zapisac jeszcze raz poprawnie uksztaltowany — ta rada jest wtedy WYKONALNA.
  it('gdy pieniedzy JESZCZE nie oddano — rada to skasowanie i ponowny zapis (WYKONALNE)', () => {
    const { blad } = paryKorekty(faktura(), {
      kwota: '19.00', kwota_dostawy: '19.00', pieniadze_oddane_at: null,
      pozycje: [{ nazwa: 'Dostawa', ilosc: 1, kwota: '19.00' }],
    });
    expect(blad).toMatch(/usuń ten zwrot i zapisz go jeszcze raz/i);
  });

  // ⚠️⚠️ DROBIAZG 2 — SEDNO. Gdy pieniadze JUZ ODDANO, `usunZwrot` ODMAWIA (pieniadze bez
  // podstawy) — rada „zapisz zwrot jeszcze raz" jest wtedy NIEWYKONALNA: kasowanie, ktorego
  // rada wymaga jako pierwszego kroku, samo dostanie odmowe. Odmowa ma wtedy mowic PRAWDE:
  // co operator MA zrobic (korekta reczna w inFakcie), nie namawiac na krok, ktory i tak
  // nie przejdzie.
  it('gdy pieniadze JUZ ODDANE — rada NIE każe kasować zwrotu (i tak dostałaby odmowę)', () => {
    const { blad } = paryKorekty(faktura(), {
      kwota: '19.00', kwota_dostawy: '19.00', pieniadze_oddane_at: '2026-08-14T10:00:00Z',
      pozycje: [{ nazwa: 'Dostawa', ilosc: 1, kwota: '19.00' }],
    });
    expect(blad).toMatch(/[Dd]ostaw/);
    expect(blad).not.toMatch(/usuń ten zwrot i zapisz go jeszcze raz/i);
    expect(blad).not.toMatch(/zapisz (ten )?zwrot jeszcze raz/i);
    expect(blad).toMatch(/wystaw (ją |korektę )?ręcznie w inFakcie/i);
    // Wyjasnienie DLACZEGO rada jest inna — pieniadze juz wyszly do kupujacego.
    expect(blad).toMatch(/pieniądze.*(oddane|wyszły)/i);
  });

  it('kazde ze zrodel OSOBNO dziala jak dotad — odmowa dotyczy wylacznie zbiegu obu', () => {
    expect(paryKorekty(faktura(), {
      kwota: '19.00', kwota_dostawy: null,
      pozycje: [{ nazwa: 'Dostawa', ilosc: 1, kwota: '19.00' }],
    }).blad).toBeNull();
    expect(paryKorekty(faktura(), {
      kwota: '0.00', kwota_dostawy: '19.00', pozycje: [],
    }).blad).toBeNull();
  });
});
