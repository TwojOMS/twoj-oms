import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../pomoc/dane-miesieczne-parytetu.js';
import { zapiszKoszt } from '../../../src/oms/db/koszty.js';
import { wskazniki, prowizjaAllegroZaMiesiac } from '../../../src/domena/wskazniki-zarzadcze.js';

const kat = (kategoria, typ, netto) => ({ kategoria, typ, nettoGrosze: netto, dokumentow: 1 });

describe('wskazniki', () => {
  it('prog rentownosci to koszty stale podzielone przez marze po zmiennych', () => {
    // Przychod 10 000, zmienne 2 000 → marza po zmiennych 80%; stale 800 → prog 1 000.
    const w = wskazniki({
      kategorie: [kat('Kurierzy', 'zmienny', 200_000), kat('Księgowość', 'staly', 80_000)],
      przychodNettoGrosze: 1_000_000, zamowien: 40,
    });
    expect(w.marzaPoZmiennych).toBeCloseTo(80, 1);
    expect(w.progRentownosciGrosze).toBe(100_000);
  });

  it('KOSZTY DROBNE NIE SA ANI STALE, ANI ZMIENNE — nie wchodza do progu', () => {
    const w = wskazniki({
      kategorie: [kat('Drobne zakupy bieżące', 'drobne', 500_000)],
      przychodNettoGrosze: 1_000_000, zamowien: 10,
    });
    expect(w.kosztyStaleGrosze).toBe(0);
    expect(w.kosztyZmienneGrosze).toBe(0);
  });

  it('ZEROWY PRZYCHOD nie daje nieskonczonego progu, tylko null', () => {
    const w = wskazniki({ kategorie: [kat('X', 'staly', 1000)], przychodNettoGrosze: 0, zamowien: 0 });
    expect(w.progRentownosciGrosze).toBeNull();
    expect(w.kosztObslugiGrosze).toBeNull();
  });

  it('koszt obslugi zamowienia to prowizje + kurierzy + opakowania na zamowienie', () => {
    const w = wskazniki({
      kategorie: [
        kat('Prowizje sprzedażowe', 'zmienny', 100_000),
        kat('Kurierzy', 'zmienny', 80_000),
        kat('Opakowania', 'zmienny', 20_000),
        kat('Księgowość', 'staly', 50_000),
      ],
      przychodNettoGrosze: 1_000_000, zamowien: 100,
    });
    expect(w.kosztObslugiGrosze).toBe(2_000);
  });
});

describe('prowizja Allegro', () => {
  let db;
  beforeEach(() => { db = openOmsDb(':memory:'); });

  const fv = (numer, dataWystawienia, netto) => zapiszKoszt(db, {
    ksefNumber: numer, numerDokumentu: numer, sprzedawcaNip: '5252674798',
    sprzedawcaNazwa: 'Allegro', dataWystawienia, dataTrwalegoZapisu: `${dataWystawienia}T12:00:00Z`,
    netto, vat: '0.00', brutto: netto, waluta: 'PLN', rodzaj: 'VAT', maZalacznik: 0,
  });

  it('⚠️ FAKTURA WYSTAWIONA 1 CZERWCA DOTYCZY MAJA — rozstrzyga okres z NUMERU', () => {
    fv('F/2026/05/123', '2026-06-01', '1312.40');
    expect(prowizjaAllegroZaMiesiac(db, '2026-05').nettoGrosze).toBe(131_240);
    expect(prowizjaAllegroZaMiesiac(db, '2026-06').nettoGrosze).toBe(0);
  });

  it('faktura bez rozpoznawalnego okresu w numerze liczy sie do miesiaca wystawienia', () => {
    fv('ABC-777', '2026-06-10', '100.00');
    expect(prowizjaAllegroZaMiesiac(db, '2026-06').nettoGrosze).toBe(10_000);
  });
});
