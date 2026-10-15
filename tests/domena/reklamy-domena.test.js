import { describe, expect, it } from 'vitest';
import { podsumujReklamy } from '../../src/domena/reklamy.js';

const okres = { od: '2026-09-16', do: '2026-09-22', dzis: '2026-09-23' };

describe('podsumujReklamy', () => {
  it('sumuje ułamki grosza z Meta przed zaokrągleniem kwoty na ekranie', () => {
    const wynik = podsumujReklamy({ ...okres, meta: [
      { dzien: '2026-09-22', kampaniaId: 'm', wydatek: '0.004', waluta: 'PLN' },
      { dzien: '2026-09-22', kampaniaId: 'n', wydatek: '0.004', waluta: 'PLN' },
    ] });
    expect(wynik.meta.koszt).toBe('0.01');
    expect(wynik.lacznie.koszt).toBe('0.01');
  });
  it('oddziela przypisany przychód GA4 od potwierdzonej aktualnej kwoty OMS', () => {
    const wynik = podsumujReklamy({
      ...okres, waluta: 'PLN', stany: { ga4: { stan: 'działa' } },
      google: [{ dzien: '2026-09-16', kampaniaId: '42', nazwa: 'Search', koszt: '104.06', klikniecia: 253, wyswietlenia: 6936, waluta: 'PLN' }],
      transakcje: [{ dzien: '2026-09-16', kampaniaId: '42', transactionId: '1451', przychod: '97.40', waluta: 'PLN' }],
      zamowienia: [{ zrodloId: '1451', kwota: '97.40', kwotaBrutto: '144.80', waluta: 'PLN', status: 'w_realizacji', atrybucja: 'direct' }],
    });
    expect(wynik.google).toMatchObject({
      koszt: '104.06', klikniecia: 253, wyswietlenia: 6936, przychodGa4: '97.40',
      przychodOms: '97.40', przychodBruttoOms: '144.80', konwersjeGa4: 1, konwersjeOms: 1, niepotwierdzone: 0,
      ctr: 253 / 6936, roasGa4: expect.any(Number), roasOms: expect.any(Number),
    });
    expect(wynik.google.roasGa4).toBe(wynik.google.roasOms);
    expect(wynik.google.cpc).toBe('0.41');
  });

  it('nie wylicza ROAS OMS z części zamówień, gdy brakuje netto produktu', () => {
    const wynik = podsumujReklamy({ ...okres, waluta: 'PLN',
      google: [{ dzien: '2026-09-16', kampaniaId: 'g', koszt: '10.00', waluta: 'PLN' }],
      transakcje: [
        { dzien: '2026-09-16', transactionId: '1', przychod: '20.00', waluta: 'PLN' },
        { dzien: '2026-09-16', transactionId: '2', przychod: '30.00', waluta: 'PLN' },
      ],
      zamowienia: [
        { zrodloId: '1', kwota: '20.00', kwotaBrutto: '30.00', waluta: 'PLN', status: 'potwierdzone' },
        { zrodloId: '2', kwota: null, kwotaBrutto: '40.00', waluta: 'PLN', status: 'potwierdzone' },
      ],
    });
    expect(wynik.google.konwersjeOms).toBe(2);
    expect(wynik.google.przychodOms).toBeNull();
    expect(wynik.google.przychodBruttoOms).toBe('70.00');
    expect(wynik.google.roasOms).toBeNull();
    expect(wynik.google.powody.przychodOms).toBe('BRAK_KWOTY_NETTO');
  });

  it('nie udaje zer przy braku połączenia, mapowania lub mianownika', () => {
    const wynik = podsumujReklamy({ ...okres, google: [], meta: [], transakcje: [], stany: {} });
    expect(wynik.google.stan).toBe('niepodłączone');
    expect(wynik.google.koszt).toBeNull();
    expect(wynik.google.powody.koszt).toBe('NIEPODLACZONE');
    expect(wynik.google.ctr).toBeNull();
    expect(wynik.google.cpc).toBeNull();
    expect(wynik.google.roasGa4).toBeNull();
    expect(wynik.meta.przychodOms).toBeNull();
    expect(wynik.meta.powody.przychodOms).toBe('BRAK_MAPOWANIA');
  });

  it('nie sumuje kosztów różnych walut i izoluje stan awarii źródła', () => {
    const wynik = podsumujReklamy({ ...okres, waluta: null,
      google: [{ dzien: '2026-09-20', kampaniaId: 'g', koszt: '10.10', klikniecia: 1, wyswietlenia: 10, waluta: 'PLN' }],
      meta: [{ dzien: '2026-09-20', kampaniaId: 'm', wydatek: '2.20', klikniecia: 1, wyswietlenia: 10, waluta: 'EUR' }],
      transakcje: [], zamowienia: [], stany: { ga4: { stan: 'działa' }, meta: { stan: 'błąd' } },
    });
    expect(wynik.google.koszt).toBe('10.10');
    expect(wynik.meta.koszt).toBe('2.20');
    expect(wynik.lacznie.koszt).toBeNull();
    expect(wynik.lacznie.powod).toBe('ROZNE_WALUTY');
    expect(wynik.google.stan).toBe('działa');
    expect(wynik.meta.stan).toBe('błąd');
  });

  it('ACTIVE bez dzisiejszej lub wczorajszej emisji nie jest emitującą kampanią', () => {
    const wynik = podsumujReklamy({ ...okres, stany: { meta: { stan: 'działa' } },
      meta: [
        { dzien: '2026-09-20', kampaniaId: 'm1', nazwa: 'Stara', effectiveStatus: 'ACTIVE', wydatek: '2.00', wyswietlenia: 100, klikniecia: 4, waluta: 'PLN' },
        { dzien: '2026-09-22', kampaniaId: 'm2', nazwa: 'Nowa', effectiveStatus: 'ACTIVE', wydatek: '1.00', wyswietlenia: 25, klikniecia: 2, waluta: 'PLN' },
        { dzien: '2026-09-22', kampaniaId: 'm3', nazwa: 'Pusta', effectiveStatus: 'ACTIVE', wydatek: '0.00', wyswietlenia: 0, klikniecia: 0, waluta: 'PLN' },
      ],
    });
    expect(wynik.meta.emitujace).toBe(1);
    expect(wynik.meta.kampanie.find((k) => k.kampaniaId === 'm1').emituje).toBe(false);
    expect(wynik.meta.kampanie.find((k) => k.kampaniaId === 'm2').emituje).toBe(true);
    expect(wynik.meta.kampanie.find((k) => k.kampaniaId === 'm3').emituje).toBe(false);
    expect(wynik.meta.dni.find((d) => d.dzien === '2026-09-22').wstepny).toBe(true);
    expect(wynik.meta.dni.find((d) => d.dzien === '2026-09-20').wstepny).toBe(false);
  });

  it('filtruje okres i nie potwierdza kolizji, anulowanych ani obcych walut', () => {
    const wynik = podsumujReklamy({ ...okres, waluta: 'PLN', stany: { ga4: { stan: 'działa' } },
      google: [
        { dzien: '2026-09-16', kampaniaId: 'g', koszt: '0.10', klikniecia: 0, wyswietlenia: 0, waluta: 'PLN' },
        { dzien: '2026-09-15', kampaniaId: 'g', koszt: '100.00', klikniecia: 3, wyswietlenia: 10, waluta: 'PLN' },
      ],
      transakcje: [
        { dzien: '2026-09-16', kampaniaId: 'g', transactionId: 'ok', przychod: '0.20', waluta: 'PLN' },
        { dzien: '2026-09-16', kampaniaId: 'g', transactionId: 'kolizja', przychod: '1.00', waluta: 'PLN' },
        { dzien: '2026-09-16', kampaniaId: 'g', transactionId: 'anul', przychod: '1.00', waluta: 'PLN' },
        { dzien: '2026-09-16', kampaniaId: 'g', transactionId: 'waluta', przychod: '1.00', waluta: 'PLN' },
      ],
      zamowienia: [
        { zrodloId: 'ok', kwota: '0.30', waluta: 'PLN', status: 'nowe' },
        { zrodloId: 'kolizja', kwota: '1.00', waluta: 'PLN', status: 'nowe' },
        { zrodloId: 'kolizja', kwota: '1.00', waluta: 'PLN', status: 'nowe' },
        { zrodloId: 'anul', kwota: '1.00', waluta: 'PLN', status: 'anulowane' },
        { zrodloId: 'waluta', kwota: '1.00', waluta: 'EUR', status: 'nowe' },
      ],
    });
    expect(wynik.google.koszt).toBe('0.10');
    expect(wynik.google.przychodGa4).toBe('3.20');
    expect(wynik.google.przychodOms).toBe('0.30');
    expect(wynik.google.konwersjeOms).toBe(1);
    expect(wynik.google.niepotwierdzone).toBe(3);
    expect(wynik.google.ctr).toBeNull();
    expect(wynik.google.cpc).toBeNull();
  });

  it('podaje łączny koszt, gdy działa tylko jedno źródło', () => {
    const wynik = podsumujReklamy({ ...okres, waluta: 'PLN',
      google: [{ dzien: '2026-09-16', kampaniaId: 'g', koszt: '0.10', klikniecia: 1, wyswietlenia: 10, waluta: 'PLN' }],
      stany: { ga4: { stan: 'działa' } },
    });
    expect(wynik.meta.stan).toBe('niepodłączone');
    expect(wynik.lacznie).toEqual({ koszt: '0.10', waluta: 'PLN', powod: null });
  });

  it('rozróżnia połączenie bez danych od dnia z prawdziwym zerem', () => {
    const pusty = podsumujReklamy({ ...okres, google: [], stany: { ga4: { stan: 'działa' } } });
    expect(pusty.google.stan).toBe('działa');
    expect(pusty.google.stanDanych).toBe('brak danych');
    expect(pusty.google.koszt).toBeNull();
    expect(pusty.google.przychodGa4).toBeNull();
    const zero = podsumujReklamy({ ...okres, google: [
      { dzien: '2026-09-16', kampaniaId: 'g', koszt: '0.00', klikniecia: 0, wyswietlenia: 0, waluta: 'PLN' },
    ], stany: { ga4: { stan: 'działa' } }, transakcje: [] });
    expect(zero.google.stanDanych).toBe('dane');
    expect(zero.google.koszt).toBe('0.00');
    expect(zero.google.przychodGa4).toBe('0.00');
    expect(zero.google.roasGa4).toBeNull();
    expect(zero.google.powody.roasGa4).toBe('BRAK_MIANOWNIKA');
  });

  it('dwie waluty jednego źródła pozostają osobnymi seriami i nie tworzą sumy', () => {
    const wynik = podsumujReklamy({ ...okres,
      google: [
        { dzien: '2026-09-16', polaczenieId: 1, kampaniaId: 'g', koszt: '10.00', klikniecia: 1, wyswietlenia: 10, waluta: 'PLN' },
        { dzien: '2026-09-16', polaczenieId: 2, kampaniaId: 'g', koszt: '20.00', klikniecia: 1, wyswietlenia: 10, waluta: 'EUR' },
      ],
    });
    expect(wynik.google.koszt).toBeNull();
    expect(wynik.google.powody.koszt).toBe('ROZNE_WALUTY');
    expect(wynik.google.dni.map((d) => [d.waluta, d.koszt])).toEqual([['PLN', '10.00'], ['EUR', '20.00']]);
    expect(wynik.google.kampanie).toHaveLength(2);
  });

  it('to samo ID transakcji z dwóch połączeń GA4 potwierdza właściwe zamówienia osobno', () => {
    const wynik = podsumujReklamy({ ...okres, waluta: 'PLN',
      google: [
        { dzien: '2026-09-16', polaczenieId: 1, kampaniaId: 'g', koszt: '10.00', klikniecia: 1, wyswietlenia: 10, waluta: 'PLN' },
        { dzien: '2026-09-16', polaczenieId: 2, kampaniaId: 'g', koszt: '20.00', klikniecia: 1, wyswietlenia: 10, waluta: 'PLN' },
      ],
      transakcje: [
        { dzien: '2026-09-16', polaczenieId: 1, kampaniaId: 'g', transactionId: '1451', przychod: '7.00', waluta: 'PLN' },
        { dzien: '2026-09-16', polaczenieId: 2, kampaniaId: 'g', transactionId: '1451', przychod: '9.00', waluta: 'PLN' },
      ],
      zamowienia: [
        { polaczenieId: 1, zrodloId: '1451', kwota: '11.00', waluta: 'PLN', status: 'nowe' },
        { polaczenieId: 2, zrodloId: '1451', kwota: '13.00', waluta: 'PLN', status: 'nowe' },
      ],
    });
    expect(wynik.google.przychodGa4).toBe('16.00');
    expect(wynik.google.przychodOms).toBe('24.00');
    expect(wynik.google.konwersjeGa4).toBe(2);
    expect(wynik.google.konwersjeOms).toBe(2);
    expect(wynik.google.niepotwierdzone).toBe(0);
  });
});
