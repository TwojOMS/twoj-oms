import { describe, it, expect } from 'vitest';
import { mapujZamowienieErli, terminWysylkiErli, sprawyErli } from '../../src/domena/erli-mapowanie.js';

// PRZ-157.04 — mapowanie zamówienia ERLI na model panelu. Dane zmyślone („Pracownia Półcień”).
function zamowienie(zmiany = {}) {
  return {
    id: 'PC-ERLI-0001',
    status: 'purchased',
    currency: 'PLN',
    market: 'pl',
    created: '2026-11-13T09:00:00Z',
    updated: '2026-11-13T09:05:00Z',
    purchasedAt: '2026-11-13T09:01:00Z',
    totalPrice: 12345,
    comment: 'Proszę o staranne zapakowanie',
    user: {
      email: 'ala@polcien.example',
      deliveryAddress: {
        firstName: 'Ala', lastName: 'Zmyślonowicz', address: 'Fikcyjna 1/2', street: 'Fikcyjna',
        buildingNumber: '1', flatNumber: '2', city: 'Testowo', country: 'pl', zip: '00-000', phone: '000000000',
      },
    },
    delivery: { name: 'Kurier testowy', typeId: 'kurierTestowy', price: 1499, cod: false },
    items: [{
      id: 501, externalId: 'PC-OF-001', quantity: 1, unitPrice: 10846, unitPriceBeforeRebate: 11846,
      name: 'Szablon malarski A4', slug: 'szablon-malarski-a4', ean: '5900000000017', sku: 'PC-SZ-A4',
      taxRate: 'TAX_23', dispatchTime: { period: 2, unit: 'day' },
    }],
    ...zmiany,
  };
}

describe('mapujZamowienieErli — statusy (D2)', () => {
  it('pending nie wchodzi do panelu', () => {
    expect(mapujZamowienieErli(zamowienie({ status: 'pending' }))).toBeNull();
  });

  it('purchased → nowe (nieanulowane), cancelled → anulowane, returned → bez anulowania', () => {
    expect(mapujZamowienieErli(zamowienie()).anulowane).toBe(0);
    expect(mapujZamowienieErli(zamowienie({ status: 'cancelled' })).anulowane).toBe(1);
    expect(mapujZamowienieErli(zamowienie({ status: 'returned' })).anulowane).toBe(0);
    expect(mapujZamowienieErli(zamowienie()).status_woo).toBe('purchased');
  });
});

describe('mapujZamowienieErli — kwoty w groszach', () => {
  it('12 345 gr → 123.45 zł, koszt dostawy i netto po stawce', () => {
    const m = mapujZamowienieErli(zamowienie());
    expect(m.kwota_brutto).toBe('123.45');
    expect(m.koszt_dostawy_brutto).toBe('14.99');
    expect(m.koszt_dostawy_netto).toBe('12.19');
    const [p] = m.pozycje;
    expect(p.cena_brutto).toBe('108.46');
    expect(p.cena_netto).toBe('88.18');
    expect(p.brutto_linii).toBe('108.46');
    expect(p.vat).toBe('23');
  });

  it('ilość mnoży linię, rabat z unitPriceBeforeRebate zostaje jako cena katalogowa', () => {
    const m = mapujZamowienieErli(zamowienie({ items: [{ ...zamowienie().items[0], quantity: 3 }] }));
    expect(m.pozycje[0].brutto_linii).toBe('325.38');
    expect(m.pozycje[0].ilosc).toBe(3);
    expect(m.pozycje[0].cena_katalogowa).toBe('118.46');
  });

  it('stawki ERLI: TAX_8 → 8, TAX_0 → 0, TAX_ZW → zw (netto = brutto)', () => {
    const poz = (taxRate) => mapujZamowienieErli(zamowienie({ items: [{ ...zamowienie().items[0], taxRate }] })).pozycje[0];
    expect(poz('TAX_8').vat).toBe('8');
    expect(poz('TAX_0').vat).toBe('0');
    expect(poz('TAX_0').cena_netto).toBe('108.46');
    expect(poz('TAX_ZW').vat).toBe('zw');
    expect(poz('TAX_ZW').cena_netto).toBe('108.46');
  });

  it('netto dostawy po stawce pierwszej pozycji: TAX_8 → 14.99 / 1.08 = 13.88, TAX_0 → brutto', () => {
    const dostawa = (taxRate) => mapujZamowienieErli(zamowienie({ items: [{ ...zamowienie().items[0], taxRate }] })).koszt_dostawy_netto;
    expect(dostawa('TAX_8')).toBe('13.88');
    expect(dostawa('TAX_0')).toBe('14.99');
  });

  it('cena, która nie jest całkowitą liczbą groszy, to błąd operatora, a nie zgadywanie', () => {
    expect(() => mapujZamowienieErli(zamowienie({ items: [{ ...zamowienie().items[0], unitPrice: '108,46' }] })))
      .toThrow(/ERLI/);
  });
});

describe('mapujZamowienieErli — pola zamówienia', () => {
  it('selfPickup oznacza odbiór osobisty', () => {
    expect(mapujZamowienieErli(zamowienie({ delivery: { typeId: 'selfPickup' } })).metoda_wysylki).toBe('odbior_osobisty');
  });
  it('pozycja: nazwa, SKU, EAN, externalId jako oferta (powiązanie z kartą)', () => {
    const [p] = mapujZamowienieErli(zamowienie()).pozycje;
    expect(p).toMatchObject({ zrodlo_id: '501', nazwa: 'Szablon malarski A4', sku: 'PC-SZ-A4', ean: '5900000000017', oferta_id: 'PC-OF-001' });
  });

  it('adres dostawy, e-mail, telefon, komentarz, data zakupu', () => {
    const m = mapujZamowienieErli(zamowienie());
    expect(m.zrodlo_id).toBe('PC-ERLI-0001');
    expect(m.numer).toBe('PC-ERLI-0001');
    expect(m.dostawa).toMatchObject({ first_name: 'Ala', last_name: 'Zmyślonowicz', address_1: 'Fikcyjna 1/2', postcode: '00-000', city: 'Testowo', country: 'PL', phone: '000000000' });
    expect(m.klient.email).toBe('ala@polcien.example');
    expect(m.uwagi).toBe('Proszę o staranne zapakowanie');
    expect(m.utworzone_at).toBe('2026-11-13T09:01:00Z');
    expect(m.metoda_wysylki_nazwa).toBe('Kurier testowy');
    expect(m.oplacone_at).toBe('2026-11-13T09:01:00Z');
  });

  it('brak e-maila nie wywraca importu', () => {
    const z = zamowienie();
    delete z.user.email;
    expect(mapujZamowienieErli(z).klient.email).toBeNull();
  });

  it('firma z NIP → dane faktury jak dla Woo (company, nip, chce_fakture)', () => {
    const m = mapujZamowienieErli(zamowienie({ user: { ...zamowienie().user, invoiceAddress: {
      type: 'company', companyName: 'Pracownia Półcień sp. z o.o.', nip: 'NIP: 0000000000', address: 'Cienista 5',
      street: 'Cienista', buildingNumber: '5', city: 'Mroczków', country: 'pl', zip: '11-111',
    } } }));
    expect(m.chce_fakture).toBe(1);
    expect(m.nip).toBe('0000000000');
    expect(m.klient).toMatchObject({ company: 'Pracownia Półcień sp. z o.o.', address_1: 'Cienista 5', postcode: '11-111', city: 'Mroczków' });
  });

  it('osoba prywatna bez faktury firmowej → bez NIP', () => {
    const m = mapujZamowienieErli(zamowienie());
    expect(m.chce_fakture).toBe(0);
    expect(m.nip).toBeNull();
  });

  it('pobranie: kwota = totalPrice, nieopłacone', () => {
    const m = mapujZamowienieErli(zamowienie({ delivery: { ...zamowienie().delivery, cod: true } }));
    expect(m.pobranie).toBe(1);
    expect(m.kwota_pobrania).toBe('123.45');
    expect(m.oplacone_at).toBeNull();
  });

  it('punkt odbioru: kod z externalId (id ERLI to liczba, nie kod punktu), opis z dostawcą i adresem', () => {
    const m = mapujZamowienieErli(zamowienie({ delivery: { ...zamowienie().delivery, pickupPlace: {
      id: 777123, externalId: 'PCN01M', provider: 'inpost', name: 'Paczkomat PCN01M', address: 'Półcieniowa 3', city: 'Testowo', zip: '00-001',
    } } }));
    expect(m.punkt_odbioru).toBe('PCN01M');
    const bezKodu = mapujZamowienieErli(zamowienie({ delivery: { ...zamowienie().delivery, pickupPlace: { id: 777123, provider: 'inpost' } } }));
    expect(bezKodu.punkt_odbioru).toBeNull();
    expect(m.punkt_odbioru_opis).toContain('Półcieniowa 3');
    expect(m.punkt_odbioru_opis).toContain('inpost');
  });
});

describe('sprawyErli — rynek i waluta (D3)', () => {
  it('rynek PL w PLN — bez spraw; brak market = pl', () => {
    expect(sprawyErli(zamowienie())).toEqual([]);
    const z = zamowienie();
    delete z.market;
    expect(sprawyErli(z)).toEqual([]);
  });

  it('rynek DE w EUR → sprawa do ręcznej obsługi', () => {
    const sprawy = sprawyErli(zamowienie({ market: 'de', currency: 'EUR' }));
    expect(sprawy.map((s) => s.tekst)).toContain('ERLI: zamówienie z rynku DE / w EUR — obsłuż ręcznie');
  });

  it('sama waluta inna niż PLN też jest sprawą, a model ją niesie', () => {
    const z = zamowienie({ currency: 'EUR' });
    expect(sprawyErli(z).map((s) => s.tekst)).toContain('ERLI: zamówienie w EUR — obsłuż ręcznie');
    expect(mapujZamowienieErli(z).sprawy.length).toBe(1);
  });
});

describe('terminWysylkiErli — D6', () => {
  const zCzasem = (dispatchTime, oms = {}) => ({
    ...zamowienie({ items: [{ ...zamowienie().items[0], dispatchTime }] }),
    _oms: oms,
  });

  it('dispatchTime z pozycji: piątek + 2 dni robocze = wtorek (przez weekend)', () => {
    expect(terminWysylkiErli(zCzasem({ period: 2, unit: 'day' }))).toEqual({ termin: '2026-11-17', przyblizony: false, zrodlo: 'pozycja' });
  });

  it('dzień zakupu liczony po warszawsku: piątek 23:30 UTC to już sobota', () => {
    const z = { ...zCzasem({ period: 1, unit: 'day' }), purchasedAt: '2026-11-13T23:30:00Z' };
    expect(terminWysylkiErli(z).termin).toBe('2026-11-16');
  });

  it('największy czas z pozycji wygrywa', () => {
    const z = zamowienie({ items: [
      { ...zamowienie().items[0], dispatchTime: { period: 1, unit: 'day' } },
      { ...zamowienie().items[0], id: 502, externalId: 'PC-OF-002', dispatchTime: { period: 3, unit: 'day' } },
    ] });
    expect(terminWysylkiErli(z).termin).toBe('2026-11-18');
  });

  it('bez dispatchTime w pozycji → czas z produktu', () => {
    const z = zCzasem(undefined, { czasyProduktow: { 'PC-OF-001': { period: 1, unit: 'day' } }, domyslnyCzasWysylki: 5 });
    expect(terminWysylkiErli(z)).toEqual({ termin: '2026-11-16', przyblizony: false, zrodlo: 'produkt' });
  });

  it('bez czasu w pozycji i produkcie → domyślny z konfiguracji kanału, termin przybliżony', () => {
    const z = zCzasem(undefined, { czasyProduktow: { 'PC-OF-001': null }, domyslnyCzasWysylki: 3 });
    expect(terminWysylkiErli(z)).toEqual({ termin: '2026-11-18', przyblizony: true, zrodlo: 'domyslny' });
  });

  it('nic nie wiadomo → pusty termin', () => {
    expect(terminWysylkiErli(zCzasem(undefined, {}))).toEqual({ termin: null, przyblizony: false, zrodlo: null });
  });

  it('unit ≠ day → pusty termin i sprawa', () => {
    const z = zCzasem({ period: 24, unit: 'hour' });
    expect(terminWysylkiErli(z).termin).toBeNull();
    expect(sprawyErli(z).map((s) => s.klucz)).toContain('erli_czas_wysylki');
  });
});
