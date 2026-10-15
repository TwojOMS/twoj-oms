import { describe, it, expect } from 'vitest';
import { dolaczZrodla } from '../../src/domena/kampania.js';

// Doklejenie danych ze zrodel zewnetrznych (Etapy 1-2) do stanu kampanii policzonego
// z wlasnej bazy. ⚠️ Wejsciem sa WIERSZE LUSTRA (kolumny bazy), a nie odpowiedzi API —
// domena nie wie, ze Meta i GA4 w ogole istnieja poza tabelami.

const stanBazowy = (nad = {}) => ({
  uzycia: 4,
  przychodZl: '600.00',
  dni: [
    { dzien: '2026-08-24', uzycia: 1, dzis: false },
    { dzien: '2026-08-25', uzycia: 3, dzis: true },
  ],
  ...nad,
});

const meta = [
  { dzien: '2026-08-24', wydatek: '30.00', wyswietlenia: 1000, zasieg: 800, klikniecia: 40, klikniecia_linku: 12 },
  { dzien: '2026-08-25', wydatek: '20.00', wyswietlenia: 600, zasieg: 500, klikniecia: 20, klikniecia_linku: 8 },
];

const ga4 = [
  { dzien: '2026-08-24', sesje: 28, uzytkownicy: 24, sesje_meta: 5, odslony_promo: 3 },
  { dzien: '2026-08-25', sesje: 12, uzytkownicy: 11, sesje_meta: 2, odslony_promo: 1 },
];

describe('dolaczZrodla — Meta', () => {
  it('sumuje wydatek, wyświetlenia i kliknięcia z dni', () => {
    const w = dolaczZrodla(stanBazowy(), { meta, ga4: [], stany: {} });
    expect(w.meta.wydatekZl).toBe('50.00');
    expect(w.meta.wyswietlenia).toBe(1600);
    expect(w.meta.klikniecia).toBe(60);
    expect(w.meta.kliknieciaLinku).toBe(20);
  });

  // ⚠️⚠️ ZASIEG TO LICZBA OSOB, NIE ZDARZEN — suma po dniach liczy dwa razy kazdego, kto
  // widzial reklame dwa dni z rzedu. Sumy zasiegu NIE MA i miec nie moze.
  it('NIE oddaje sumy zasięgu — bo to liczba osób, nie zdarzeń', () => {
    const w = dolaczZrodla(stanBazowy(), { meta, ga4: [], stany: {} });
    expect(w.meta.zasieg).toBeUndefined();
    expect(w.meta.zasiegNajlepszyDzien).toBe(800);
  });

  it('CPC liczy z wydatku i wszystkich kliknięć — ta sama miara co punkt odniesienia 0,125 zł', () => {
    const w = dolaczZrodla(stanBazowy(), { meta, ga4: [], stany: {} });
    expect(w.meta.cpcZl).toBe('0.83');
  });

  it('koszt na użycie kodu: wydatek podzielony przez użycia', () => {
    const w = dolaczZrodla(stanBazowy({ uzycia: 4 }), { meta, ga4: [], stany: {} });
    expect(w.meta.kosztUzyciaZl).toBe('12.50');
  });

  // ⚠️ ZERO UZYC TO NIE JEST „koszt 0 zl" ANI awaria — to brak miary. Liczba wziela by sie
  // z dzielenia przez zero i wygladalaby jak fakt.
  it('zero użyć → koszt na użycie jest niedostępny, nie zerowy', () => {
    const w = dolaczZrodla(stanBazowy({ uzycia: 0, przychodZl: '0.00' }), { meta, ga4: [], stany: {} });
    expect(w.meta.kosztUzyciaZl).toBeNull();
  });

  // ⚠️⚠️ ALE ZEROWY ZWROT PRZY WYDANYCH PIENIADZACH TO PRAWDA, NIE BRAK DANYCH — i to
  // najwazniejsza prawda, jaka ten ekran moze powiedziec. Ukrycie jej pod myslnikiem
  // („brak miary") zamienialoby nieudana kampanie w kampanie bez wyniku.
  it('wydatek bez ani jednego zamówienia → ROAS zero, nie myślnik', () => {
    const w = dolaczZrodla(stanBazowy({ uzycia: 0, przychodZl: '0.00' }), { meta, ga4: [], stany: {} });
    expect(w.meta.roas).toBe('0.0');
  });

  it('zero wydatku → CPC i ROAS niedostępne (reklama jeszcze nie ruszyła)', () => {
    const bezWydatku = [{ dzien: '2026-08-24', wydatek: '0.00', wyswietlenia: 0, zasieg: 0, klikniecia: 0, klikniecia_linku: 0 }];
    const w = dolaczZrodla(stanBazowy(), { meta: bezWydatku, ga4: [], stany: {} });
    expect(w.meta.cpcZl).toBeNull();
    expect(w.meta.roas).toBeNull();
    expect(w.meta.kosztUzyciaZl).toBeNull();
  });

  it('ROAS: przychód z kodem na złotówkę reklamy', () => {
    const w = dolaczZrodla(stanBazowy({ przychodZl: '600.00' }), { meta, ga4: [], stany: {} });
    expect(w.meta.roas).toBe('12.0');
  });

  it('brak danych Mety → sekcja pusta, a nie zera', () => {
    const w = dolaczZrodla(stanBazowy(), { meta: [], ga4: [], stany: {} });
    expect(w.meta.saDane).toBe(false);
    expect(w.meta.wydatekZl).toBe('0.00');
  });
});

describe('dolaczZrodla — GA4', () => {
  it('sumuje sesje, sesje z Mety i odsłony strony promocji', () => {
    const w = dolaczZrodla(stanBazowy(), { meta: [], ga4, stany: {} });
    expect(w.ga4.sesje).toBe(40);
    expect(w.ga4.sesjeMeta).toBe(7);
    expect(w.ga4.odslonyPromo).toBe(4);
  });

  // ⚠️ `totalUsers` to liczba UNIKALNYCH ludzi w dniu — suma po dniach liczyla by dwa razy
  // kazdego, kto wrocil nazajutrz. Ta sama zasada, co przy zasiegu Mety.
  it('NIE oddaje sumy użytkowników', () => {
    const w = dolaczZrodla(stanBazowy(), { meta: [], ga4, stany: {} });
    expect(w.ga4.uzytkownicy).toBeUndefined();
  });

  // ⚠️ Zamowienia liczymy z WLASNEJ bazy, nie z GA4 — wspolczynnik jest pogladowy i tak
  // ma byc opisany na ekranie (rozjazd klikniec Mety do sesji GA4 bywa dziesieciokrotny).
  it('podaje ile sesji przypada na jedno użycie kodu', () => {
    const w = dolaczZrodla(stanBazowy({ uzycia: 4 }), { meta: [], ga4, stany: {} });
    expect(w.ga4.sesjiNaUzycie).toBe('10.0');
  });

  it('zero użyć → współczynnik niedostępny', () => {
    const w = dolaczZrodla(stanBazowy({ uzycia: 0 }), { meta: [], ga4, stany: {} });
    expect(w.ga4.sesjiNaUzycie).toBeNull();
  });
});

describe('dolaczZrodla — dni i stany źródeł', () => {
  it('dokleja liczby do dni kampanii, po dniu', () => {
    const w = dolaczZrodla(stanBazowy(), { meta, ga4, stany: {} });
    const pierwszy = w.dni.find((d) => d.dzien === '2026-08-24');
    expect(pierwszy).toMatchObject({ uzycia: 1, wydatekZl: '30.00', sesje: 28, odslonyPromo: 3 });
  });

  it('dzień bez danych ze źródeł zachowuje użycia i dostaje zera', () => {
    const w = dolaczZrodla(stanBazowy(), { meta: [meta[0]], ga4: [], stany: {} });
    expect(w.dni.find((d) => d.dzien === '2026-08-25')).toMatchObject({ uzycia: 3, wydatekZl: '0.00', sesje: 0 });
  });

  // ⚠️⚠️ SEDNO STANU ZRODLA: zera przy padnietym kluczu wygladaja DOKLADNIE tak samo jak
  // zera przy reklamie, ktora nie chodzi. Ekran musi dostac jedno i drugie.
  it('przenosi błąd i znacznik ostatniego udanego pobrania', () => {
    const stany = {
      meta: { ostatni_sukces_at: '2026-08-25T06:00:00Z', ostatni_blad: 'Meta odmówiła: token wygasł' },
      ga4: { ostatni_sukces_at: '2026-08-25T07:00:00Z', ostatni_blad: null },
    };
    const w = dolaczZrodla(stanBazowy(), { meta, ga4, stany });
    expect(w.meta.blad).toMatch(/token wygasł/);
    expect(w.meta.ostatniSukcesAt).toBe('2026-08-25T06:00:00Z');
    expect(w.ga4.blad).toBeNull();
  });

  it('źródło, o które nikt nie pytał, nie ma ani błędu, ani znacznika', () => {
    const w = dolaczZrodla(stanBazowy(), { meta: [], ga4: [], stany: {} });
    expect(w.meta.blad).toBeNull();
    expect(w.meta.ostatniSukcesAt).toBeNull();
  });
});
