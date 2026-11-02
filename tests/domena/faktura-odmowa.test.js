import { describe, it, expect } from 'vitest';
import { powodOdmowyFaktury, powodOdmowyZaplaconej } from '../../src/domena/faktura-odmowa.js';

const zam = (n) => ({
  id: 1, numer: '3001', okres_rozliczeniowy_id: null, anulowane: 0, chce_fakture: 1,
  nip: '1234563218', kwota_brutto: '123.00', pozycje: [], platnosci: [], ...n,
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
