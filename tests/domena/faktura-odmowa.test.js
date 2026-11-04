import { describe, it, expect } from 'vitest';
import { powodOdmowyFaktury, powodOdmowyZaplaconej } from '../../src/domena/faktura-odmowa.js';

const zam = (n) => ({
  id: 1, numer: '3001', okres_rozliczeniowy_id: null, anulowane: 0, chce_fakture: 1,
  nip: '1234563218', kwota_brutto: '123.00', pozycje: [], platnosci: [],
  klient: { company: 'Pracownia Półcień', address_1: 'Lampowa 1', postcode: '00-950', city: 'Warszawa', country: 'PL' }, ...n,
});

describe('powod odmowy faktury', () => {
  it('przepuszcza zwykle zamowienie', () => {
    expect(powodOdmowyFaktury(zam())).toBeNull();
  });

  it('odmawia zamowieniu z okresu rozliczeniowego i podaje adres ekranu okresu', () => {
    const powod = powodOdmowyFaktury(zam({ okres_rozliczeniowy_id: 7 }));
    expect(powod).toMatch(/okres/i);
    expect(powod).toContain('/okresy/7');
  });

  it('odmawia anulowanemu', () => {
    expect(powodOdmowyFaktury(zam({ anulowane: 1 }))).toMatch(/anulowane/i);
  });

  it('odmawia, gdy klient nie prosil o fakture', () => {
    expect(powodOdmowyFaktury(zam({ chce_fakture: 0, nip: null }))).toMatch(/nie prosił/i);
  });

  it('odmawia brakowi zamowienia (null i undefined), a nie rzuca', () => {
    expect(powodOdmowyFaktury(null)).toBe('Nie ma takiego zamówienia.');
    expect(powodOdmowyFaktury(undefined)).toBe('Nie ma takiego zamówienia.');
  });

  // ⚠️ KOLEJNOSC ODMOW JEST CZESCIA REGULY: „nalezy do okresu" to fakt STRUKTURALNY i stoi
  // przed wszystkimi innymi. Zamowienie z okresu, ktore jest przy okazji anulowane, ma
  // powiedziec o okresie — bo to ono kieruje czlowieka na wlasciwy ekran.
  it('okres wygrywa nad anulowaniem', () => {
    expect(powodOdmowyFaktury(zam({ okres_rozliczeniowy_id: 7, anulowane: 1 }))).toMatch(/okres/i);
  });
});

// PRZ-126.F02: opcja firmy „faktura także bez prośby klienta”. Wyłączona (domyślnie) = odmowa jak dziś;
// włączona zdejmuje WYŁĄCZNIE odmowę „nie prosił” — scalone, okres i anulowane nadal odmawiają tą samą treścią.
describe('powod odmowy faktury — opcja dla kazdego (PRZ-126)', () => {
  const bezZadania = (n) => zam({ chce_fakture: 0, nip: null, ...n });

  it('bez opcji i z dlaKazdego: false odmawia zamowieniu bez zadania dokladnie ta sama trescia', () => {
    expect(powodOdmowyFaktury(bezZadania())).toBe('Klient nie prosił o fakturę.');
    expect(powodOdmowyFaktury(bezZadania(), {})).toBe('Klient nie prosił o fakturę.');
    expect(powodOdmowyFaktury(bezZadania(), { okresyWlaczone: true, dlaKazdego: false })).toBe('Klient nie prosił o fakturę.');
  });

  it('z dlaKazdego: true przepuszcza zamowienie bez zadania', () => {
    expect(powodOdmowyFaktury(bezZadania(), { dlaKazdego: true })).toBeNull();
  });

  it('z dlaKazdego: true nadal odmawia anulowanemu, scalonemu i z okresu — ta sama tresc co bez opcji', () => {
    for (const n of [
      { anulowane: 1 },
      { scalone_do: 9, scalone_do_numer: '3009' },
      { okres_rozliczeniowy_id: 7 },
    ]) {
      const dzis = powodOdmowyFaktury(bezZadania(n));
      expect(dzis).not.toBeNull();
      expect(powodOdmowyFaktury(bezZadania(n), { dlaKazdego: true })).toBe(dzis);
    }
  });

  it('z dlaKazdego: true odmawia brakowi zamowienia', () => {
    expect(powodOdmowyFaktury(null, { dlaKazdego: true })).toBe('Nie ma takiego zamówienia.');
  });
});

// PRZ-126.PT5 (decyzja 8): bez adresu nabywcy nie ma faktury. Reguła czyta `daneFaktury(z)`
// (ręczne nadpisanie wygrywa) i stoi OSTATNIA — anulowane, okres, scalone i „nie prosił” mówią pierwsze.
describe('powod odmowy faktury — adres nabywcy (PRZ-126.PT5)', () => {
  const bezAdresu = (n) => zam({ klient: { company: 'Pracownia Półcień' }, ...n });

  it('odmawia bez adresu i wymienia braki po kolei', () => {
    expect(powodOdmowyFaktury(bezAdresu())).toBe(
      'Brak adresu nabywcy (ulica, kod pocztowy, miasto). Uzupełnij dane do faktury na karcie zamówienia.');
    expect(powodOdmowyFaktury(zam({ klient: { address_1: 'Lampowa 1', city: 'Warszawa' } }))).toBe(
      'Brak adresu nabywcy (kod pocztowy). Uzupełnij dane do faktury na karcie zamówienia.');
  });

  it('osoba prywatna (bez NIP i firmy) z adresem — można; bez adresu — odmowa', () => {
    const osoba = { first_name: 'Ala', last_name: 'Przykładowa' };
    expect(powodOdmowyFaktury(zam({ nip: null, klient: { ...osoba, address_1: 'Lampowa 1', postcode: '00-950', city: 'Warszawa' } }))).toBeNull();
    expect(powodOdmowyFaktury(zam({ nip: null, klient: osoba }))).toMatch(/^Brak adresu nabywcy/);
  });

  it('nabywca zagraniczny bez kodu pocztowego — można', () => {
    expect(powodOdmowyFaktury(zam({ klient: { address_1: 'Lampenweg 1', city: 'Berlin', country: 'DE' } }))).toBeNull();
  });

  it('adres uzupełniony ręcznie przy pustym adresie ze sklepu — można', () => {
    const reczny = JSON.stringify({ ulica: 'Lampowa 1', kod: '00-950', miasto: 'Warszawa' });
    expect(powodOdmowyFaktury(bezAdresu({ klient_reczny_json: reczny }))).toBeNull();
  });

  it('adres sprawdzany ostatni: anulowane, okres, scalone i brak prośby wygrywają', () => {
    expect(powodOdmowyFaktury(bezAdresu({ anulowane: 1 }))).toMatch(/anulowane/i);
    expect(powodOdmowyFaktury(bezAdresu({ okres_rozliczeniowy_id: 7 }))).toContain('/okresy/7');
    expect(powodOdmowyFaktury(bezAdresu({ scalone_do: 9, scalone_do_numer: '3009' }))).toMatch(/scalone/);
    expect(powodOdmowyFaktury(bezAdresu({ chce_fakture: 0, nip: null }))).toBe('Klient nie prosił o fakturę.');
    expect(powodOdmowyFaktury(bezAdresu({ chce_fakture: 0, nip: null }), { dlaKazdego: true })).toMatch(/^Brak adresu nabywcy/);
  });
});

describe('powod odmowy wariantowi zaplaconemu', () => {
  it('przepuszcza pokrycie co do grosza i nadplate', () => {
    const pokryte = zam({ kwota_brutto: '123.00', platnosci: [{ kwota: '123.00' }] });
    expect(powodOdmowyZaplaconej(pokryte)).toBeNull();
    const nadplata = zam({ kwota_brutto: '123.00', platnosci: [{ kwota: '200.00' }] });
    expect(powodOdmowyZaplaconej(nadplata)).toBeNull();
  });

  it('odmawia niedoplacie i podaje obie kwoty', () => {
    const powod = powodOdmowyZaplaconej(zam({ kwota_brutto: '123.00', platnosci: [{ kwota: '100.00' }] }));
    expect(powod).toContain('100.00');
    expect(powod).toContain('123.00');
  });

  it('odmawia brakowi wplat', () => {
    expect(powodOdmowyZaplaconej(zam({ platnosci: [] }))).toMatch(/wpłat/i);
  });

  it('odmawia brakowi zamowienia (null i undefined), a nie rzuca', () => {
    expect(powodOdmowyZaplaconej(null)).toBe('Nie ma takiego zamówienia.');
    expect(powodOdmowyZaplaconej(undefined)).toBe('Nie ma takiego zamówienia.');
  });
});
