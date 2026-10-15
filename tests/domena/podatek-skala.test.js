import { describe, it, expect } from 'vitest';
import { podatekNarastajaco, prognozaProgu, PROG_GROSZE } from '../../src/domena/podatek-skala.js';

describe('podatek — skala 12/32%', () => {
  it('skladki SPOLECZNE pomniejszaja podstawe, ZDROWOTNA nie (funkcja jej nie zna)', () => {
    const w = podatekNarastajaco({ dochodGrosze: 5_000_000, spoleczneGrosze: 1_000_000 });
    expect(w.podstawaGrosze).toBe(4_000_000);
  });

  it('podstawa zaokragla sie do pelnych zlotych, jak w zeznaniu', () => {
    expect(podatekNarastajaco({ dochodGrosze: 100_049, spoleczneGrosze: 0 }).podstawaGrosze)
      .toBe(100_000);
    expect(podatekNarastajaco({ dochodGrosze: 100_050, spoleczneGrosze: 0 }).podstawaGrosze)
      .toBe(100_100);
  });

  it('12% minus kwota zmniejszajaca 3600 zl', () => {
    // Podstawa 100 000 zl → 12 000 − 3 600 = 8 400 zl.
    expect(podatekNarastajaco({ dochodGrosze: 10_000_000, spoleczneGrosze: 0 }).podatekGrosze)
      .toBe(840_000);
  });

  it('PODATEK NIE SCHODZI PONIZEJ ZERA przy niskiej podstawie', () => {
    expect(podatekNarastajaco({ dochodGrosze: 1_000_000, spoleczneGrosze: 0 }).podatekGrosze).toBe(0);
  });

  it('WYKRYWA WEJSCIE W DRUGI PROG — po to raport liczy narastajaco', () => {
    const w = podatekNarastajaco({ dochodGrosze: 13_000_000, spoleczneGrosze: 0 });
    expect(w.wDrugimProgu).toBe(true);
    // 120 000 × 12% − 3 600 = 10 800; nadwyzka 10 000 × 32% = 3 200 → 14 000 zl.
    expect(w.podatekGrosze).toBe(1_400_000);
  });

  it('mowi, ile brakuje do progu', () => {
    const w = podatekNarastajaco({ dochodGrosze: 3_910_100, spoleczneGrosze: 0 });
    expect(w.doProguGrosze).toBe(PROG_GROSZE - 3_910_100);
    expect(w.wDrugimProgu).toBe(false);
  });
});

describe('prognoza przekroczenia progu 32%', () => {
  // Siedem pelnych miesiecy po 9 675 000 gr (96 750 zl narastajaco) → tempo 13 821,43 zl/mies.,
  // rok ok. 165 857 zl, wiec prog pada w miesiacu 9.
  const LIPIEC = { podstawaGrosze: 9_675_000, doDnia: '2026-07-31' };

  it('liczy tempo liniowe i podstawe na koniec roku', () => {
    const p = prognozaProgu(LIPIEC);
    expect(p.tempoGrosze).toBe(Math.round(9_675_000 / 7));
    expect(p.podstawaRokuGrosze).toBe(Math.round(9_675_000 / 7) * 12);
    expect(p.przekroczy).toBe(true);
  });

  it('wskazuje MIESIAC przekroczenia progu', () => {
    // 120 000 zl / 13 821,43 zl = 8,68 → prog pada w dziewiatym miesiacu.
    expect(prognozaProgu(LIPIEC).miesiacPrzekroczenia).toBe(9);
  });

  it('liczy DOPLATE: nadwyzka po 32% zamiast 12%, czyli roznica dwudziestu punktow', () => {
    const p = prognozaProgu(LIPIEC);
    expect(p.nadwyzkaGrosze).toBe(p.podstawaRokuGrosze - PROG_GROSZE);
    expect(p.dodatkowyPodatekGrosze).toBe(Math.round(p.nadwyzkaGrosze * 0.20));
  });

  it('MOWI WPROST, gdy przy dzisiejszym tempie progu NIE BEDZIE — zamiast milczec', () => {
    const p = prognozaProgu({ podstawaGrosze: 3_500_000, doDnia: '2026-07-31' });
    expect(p.przekroczy).toBe(false);
    expect(p.miesiacPrzekroczenia).toBe(null);
    expect(p.nadwyzkaGrosze).toBe(0);
  });

  it('⚠️ NIE PROGNOZUJE z zakresu urwanego w polowie miesiaca — tempo byloby zawyzone', () => {
    // Podstawa narastajaco do 17 sierpnia podzielona przez osiem miesiecy udawalaby, ze
    // sierpien juz sie policzyl w calosci.
    expect(prognozaProgu({ podstawaGrosze: 9_675_000, doDnia: '2026-08-17' })).toBe(null);
  });

  it('⚠️ NIE PROGNOZUJE ponizej trzech pelnych miesiecy — tempo z jednego to szum', () => {
    expect(prognozaProgu({ podstawaGrosze: 4_000_000, doDnia: '2026-02-28' })).toBe(null);
    expect(prognozaProgu({ podstawaGrosze: 4_000_000, doDnia: '2026-03-31' })).not.toBe(null);
  });

  it('⚠️ MILCZY W GRUDNIU — rok jest zamkniety, nie ma czego prognozowac', () => {
    expect(prognozaProgu({ podstawaGrosze: 15_000_000, doDnia: '2026-12-31' })).toBe(null);
  });

  it('⚠️ MILCZY, gdy prog JUZ przekroczony — ekran mowi to wprost, prognoza nie ma sensu', () => {
    expect(prognozaProgu({ podstawaGrosze: PROG_GROSZE + 1, doDnia: '2026-07-31' })).toBe(null);
  });

  it('zerowa podstawa nie dzieli przez zero i nie wrozy przekroczenia', () => {
    const p = prognozaProgu({ podstawaGrosze: 0, doDnia: '2026-06-30' });
    expect(p.przekroczy).toBe(false);
    expect(p.podstawaRokuGrosze).toBe(0);
  });

  it('koniec miesiaca rozpoznaje sie po DLUGOSCI TEGO miesiaca, nie po liczbie 31', () => {
    // Kwiecien ma 30 dni: 30.04 to koniec miesiaca, 29.04 juz nie.
    expect(prognozaProgu({ podstawaGrosze: 4_000_000, doDnia: '2026-04-30' })).not.toBe(null);
    expect(prognozaProgu({ podstawaGrosze: 4_000_000, doDnia: '2026-04-29' })).toBe(null);
  });
});
