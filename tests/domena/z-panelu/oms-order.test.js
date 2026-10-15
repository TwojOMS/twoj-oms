import { describe, it, expect } from 'vitest';
import { buildOmsOrderInput } from '../../../src/domena/z-panelu/oms-order.js';

// ⚠️ Test przypina CALY obiekt (`toEqual`), nie pojedyncze pola. Powod jest z Fazy 10
// panelu: asercje `toContain` na fragmentach przepuscily zmiane formatu maila, ktora
// dotykala KAZDEJ wysylanej wyceny. Tu stawka jest ta sama — to jest tresc zamowienia.
const karta = {
  id: 'karta-abc',
  klientNazwa: 'Jan Kowalski',
  klientEmail: 'jan@example.com',
  quote: {
    items: [{ rodzaj: 'szablon malarski wielorazowy', nazwa: 'logo firmy', rozmiar: '70x100cm', qty: 2, price: '250.00' }],
    shipping: '19',
  },
  orderData: {
    shipping: { name: 'Jan Kowalski', street: 'Długa 45', postal: '30-001', city: 'Kraków', phone: '500900008' },
    invoice: { wanted: true, company: 'ACME sp. z o.o.', nip: '1000001112', sameAsShipping: true, street: '', postal: '', city: '' },
  },
};

describe('buildOmsOrderInput', () => {
  it('sklada cale zadanie z wyceny i danych zamowienia', () => {
    expect(buildOmsOrderInput(karta, { publicBaseUrl: 'http://192.168.0.10:3000' })).toEqual({
      kartaId: 'karta-abc',
      klient: {
        first_name: 'Jan', last_name: 'Kowalski', company: 'ACME sp. z o.o.',
        address_1: 'Długa 45', postcode: '30-001', city: 'Kraków', country: 'PL',
        phone: '500900008', email: 'jan@example.com',
      },
      dostawa: {
        first_name: 'Jan', last_name: 'Kowalski', company: '',
        address_1: 'Długa 45', postcode: '30-001', city: 'Kraków', country: 'PL',
      },
      nip: '1000001112',
      chceFakture: true,
      kosztDostawyBrutto: '19',
      pozycje: [{
        nazwa: 'szablon malarski wielorazowy logo firmy 70x100cm',
        ilosc: 2, cena_brutto: '250.00',
      }],
      uwagi: 'Zamówienie indywidualne — karta karta-abc\nhttp://192.168.0.10:3000/cards/karta-abc',
    });
  });

  it('bez faktury nie wysyla ani NIP-u, ani firmy', () => {
    const bezFv = { ...karta, orderData: { ...karta.orderData, invoice: { wanted: false, company: '', nip: '' } } };
    const wynik = buildOmsOrderInput(bezFv, { publicBaseUrl: null });
    expect(wynik.chceFakture).toBe(false);
    expect(wynik.nip).toBeNull();
    expect(wynik.klient.company).toBe('');
    expect(wynik.uwagi).toBe('Zamówienie indywidualne — karta karta-abc');
  });

  // ⚠️ Test przypina CAŁE bloki `klient` i `dostawa` (`toEqual`), nie tylko `address_1`.
  // Blok `klient` to dane NABYWCY NA FAKTURZE — regresja, która wzięłaby kod pocztowy i
  // miasto z adresu WYSYŁKOWEGO (a tylko ulicę z faktury), przeszłaby zielono przy
  // asercji na samym `address_1`, mimo że faktura pojechałaby z błędnym adresem nabywcy.
  it('faktura na inny adres bierze adres z sekcji faktury', () => {
    const inny = {
      ...karta,
      orderData: {
        ...karta.orderData,
        invoice: { wanted: true, company: 'ACME', nip: '1000001112', sameAsShipping: false, street: 'Krótka 1', postal: '31-002', city: 'Wieliczka' },
      },
    };
    const wynik = buildOmsOrderInput(inny, { publicBaseUrl: null });
    expect(wynik.klient).toEqual({
      first_name: 'Jan', last_name: 'Kowalski', company: 'ACME',
      address_1: 'Krótka 1', postcode: '31-002', city: 'Wieliczka', country: 'PL',
      phone: '500900008', email: 'jan@example.com',
    });
    expect(wynik.dostawa).toEqual({
      first_name: 'Jan', last_name: 'Kowalski', company: '',
      address_1: 'Długa 45', postcode: '30-001', city: 'Kraków', country: 'PL',
    });
  });

  // Karta bez `orderData` i bez `quote` jest stanem LEGALNYM (np. karta dopiero co
  // utworzona) — funkcja nie ma prawa wybuchnąć, tylko oddać puste bloki adresowe.
  it('bez orderData i bez quote oddaje puste bloki adresowe i zerowe zamówienie', () => {
    const goła = { id: 'karta-xyz', klientNazwa: 'Anna Nowak', klientEmail: 'anna@example.com' };
    const wynik = buildOmsOrderInput(goła, { publicBaseUrl: null });
    expect(wynik.klient).toEqual({
      first_name: 'Anna', last_name: 'Nowak', company: '',
      address_1: '', postcode: '', city: '', country: 'PL',
      phone: '', email: 'anna@example.com',
    });
    expect(wynik.dostawa).toEqual({
      first_name: 'Anna', last_name: 'Nowak', company: '',
      address_1: '', postcode: '', city: '', country: 'PL',
    });
    expect(wynik.pozycje).toEqual([]);
    expect(wynik.kosztDostawyBrutto).toBe('0');
  });

  /* DODATKI DOBRANE PRZEZ KLIENTA (formularz proformy, 22.08.2026) — ekspres i kolejny
     egzemplarz wybrane PO wysłaniu wyceny.

     ⚠️ Ten test powstał, bo weryfikacja mutacyjna pokazała dziurę: usługa proformy przekazuje
     `dodatki`, ale w jej testach `addOrderToOms` jest atrapą, więc usunięcie dodatków z tej
     funkcji nie zapalało niczego na czerwono. Skutek takiej cichej awarii: zamówienie w OMS-ie
     opiewa na mniej, niż klient zatwierdził, „opłacone" (wymaga pokrycia CAŁEJ kwoty) nie
     zapala się NIGDY i ETAP IV staje bez żadnego błędu. */
  it('⚠️ dodatki klienta wchodzą do pozycji zamówienia, ZA wyceną i projektem', () => {
    const karta = {
      id: 'karta-1',
      klientNazwa: 'Anna Kowalska',
      klientEmail: 'anna@example.com',
      quote: { items: [{ nazwa: 'logo', qty: 2, price: 120 }], shipping: 19, projekt: 80 },
    };
    const wynik = buildOmsOrderInput(karta, {
      dodatki: [{ nazwa: 'Realizacja ekspresowa 48h', ilosc: 1, cena_brutto: '50' }],
    });
    expect(wynik.pozycje).toEqual([
      { nazwa: 'logo', ilosc: 2, cena_brutto: '120' },
      { nazwa: 'przygotowanie projektu', ilosc: 1, cena_brutto: '80' },
      { nazwa: 'Realizacja ekspresowa 48h', ilosc: 1, cena_brutto: '50' },
    ]);
  });

  // Ręczne „Dodaj do OMS" zakłada zamówienie dokładnie na zaakceptowaną wycenę — brak
  // dodatków nie może niczego dołożyć ani wywrócić.
  it('bez dodatków zamówienie jest dokładnie takie jak wycena', () => {
    const karta = { id: 'k', klientNazwa: 'A B', quote: { items: [{ nazwa: 'logo', qty: 1, price: 100 }], shipping: 0, projekt: 0 } };
    expect(buildOmsOrderInput(karta).pozycje).toEqual([{ nazwa: 'logo', ilosc: 1, cena_brutto: '100' }]);
    expect(buildOmsOrderInput(karta, { dodatki: null }).pozycje).toHaveLength(1);
  });
});
