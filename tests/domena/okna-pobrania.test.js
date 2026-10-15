import { describe, it, expect } from 'vitest';
import {
  PODLOGA_KOSZTOW, ZAPAS_KURSORA_MS, podzielNaOkna, nastepnyKrok, odKursora,
} from '../../src/domena/okna-pobrania.js';

describe('okna pobrania', () => {
  it('rok dzieli na okna nie dluzsze niz 3 miesiace', () => {
    const okna = podzielNaOkna('2026-01-01T00:00:00Z', '2026-08-12T00:00:00Z');
    expect(okna).toEqual([
      { from: '2026-01-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z' },
      { from: '2026-04-01T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' },
      { from: '2026-07-01T00:00:00.000Z', to: '2026-08-12T00:00:00.000Z' },
    ]);
  });

  it('okno krotsze niz 3 miesiace zostaje jednym oknem', () => {
    expect(podzielNaOkna('2026-05-01T00:00:00Z', '2026-06-01T00:00:00Z')).toHaveLength(1);
  });

  it('hasMore=false konczy pobieranie', () => {
    expect(nastepnyKrok({ hasMore: false, isTruncated: false, pageOffset: 3 })).toEqual({ koniec: true });
  });

  it('hasMore bez obciecia zwieksza strone', () => {
    expect(nastepnyKrok({ hasMore: true, isTruncated: false, pageOffset: 3 })).toEqual({ pageOffset: 4 });
  });

  it('obciecie przesuwa okno na date ostatniego rekordu i ZERUJE strone', () => {
    expect(nastepnyKrok({ hasMore: true, isTruncated: true, pageOffset: 40, ostatniaData: '2026-03-07T10:00:00Z' }))
      .toEqual({ from: '2026-03-07T10:00:00Z', pageOffset: 0 });
  });

  it('⚠️ kursor NIGDY nie schodzi ponizej podlogi', () => {
    expect(odKursora(null)).toBe(PODLOGA_KOSZTOW);
    expect(odKursora('2025-06-01T00:00:00Z')).toBe(PODLOGA_KOSZTOW);
  });

  // ⚠️⚠️ OKNO PRZYROSTOWE MA ZAPAS — inaczej dokument zapisany w KSeF PRZED kursorem, ale
  // widoczny w zapytaniu dopiero pozniej (opoznienie indeksu MF, dwa dokumenty z tym samym
  // znacznikiem czasu, `from` okazujace sie wylaczajace), nie trafi juz do ZADNEGO przyszlego
  // okna: kursor nad nim przeskoczyl, a podloga zabrania cofania. Objaw: zanizona suma
  // miesiaca, bez ani jednego bledu.
  describe('zapas przed kursorem', () => {
    it('⚠️ okno zaczyna sie PRZED kursorem, o pelna wartosc zapasu', () => {
      const kursor = '2026-05-20T12:00:00.000Z';
      const od = odKursora(kursor);
      expect(new Date(kursor) - new Date(od)).toBe(ZAPAS_KURSORA_MS);
    });

    it('⚠️ zapas NIE schodzi ponizej podlogi', () => {
      // Kursor tuz nad podloga: cofniecie o zapas wypadloby w rok poprzedni, czyli w okres,
      // ktorego panel celowo nie czyta.
      expect(odKursora('2026-01-02T00:00:00.000Z')).toBe(PODLOGA_KOSZTOW);
      expect(new Date(odKursora('2026-01-08T00:00:00.000Z')).getTime())
        .toBeGreaterThanOrEqual(new Date(PODLOGA_KOSZTOW).getTime());
    });

    // ⚠️ D1: kursor „z przyszlosci" (skew zegara, data z KSeF w innej strefie) dawal PUSTA
    // liste okien — czuwacz nie robil NIC, na zawsze, bez ani jednego bledu.
    it('⚠️ kursor z przyszlosci nie daje pustej listy okien', () => {
      const teraz = '2026-06-01T00:00:00.000Z';
      const od = odKursora('2026-09-01T00:00:00.000Z', teraz);
      expect(new Date(od).getTime()).toBeLessThan(new Date(teraz).getTime());
      expect(podzielNaOkna(od, teraz).length).toBeGreaterThan(0);
    });

    // Kursor nieczytelny to stan, ktorego panel nie umie rozstrzygnac — a `new Date(NaN)`
    // konczyl sie tak samo jak kursor z przyszlosci: pusta lista okien i cisza. Czytamy
    // wtedy od podlogi (dublety sa darmowe, dziura w kosztach nie).
    it('⚠️ kursor nieczytelny czyta od podlogi, a nie z pustej listy okien', () => {
      expect(odKursora('nie-data')).toBe(PODLOGA_KOSZTOW);
    });
  });

  it('⚠️ start 2026-01-31 (przepelnienie miesiaca) nie tworzy okna dluzszego niz 3 miesiace', () => {
    const okna = podzielNaOkna('2026-01-31T00:00:00Z', '2026-12-31T00:00:00Z');
    // Buggy setUTCMonth() dla 31 stycznia + 3 miesiace celuje w "31 kwietnia" (ktorego nie ma)
    // i przelewa sie na 1 maja - okno wyszloby DLUZSZE niz limit KSeF. Naprawiona wersja cofa
    // sie na ostatni dzien miesiaca docelowego, wiec pierwsze okno konczy sie 30 kwietnia.
    expect(okna).toEqual([
      { from: '2026-01-31T00:00:00.000Z', to: '2026-04-30T00:00:00.000Z' },
      { from: '2026-04-30T00:00:00.000Z', to: '2026-07-30T00:00:00.000Z' },
      { from: '2026-07-30T00:00:00.000Z', to: '2026-10-30T00:00:00.000Z' },
      { from: '2026-10-30T00:00:00.000Z', to: '2026-12-31T00:00:00.000Z' },
    ]);
    // niezmiennik ogolny: zadne okno nie przekracza 3 miesiecy kalendarzowych, niezaleznie
    // od dnia startowego - luty-kwiecien to najkrotsze trzy kolejne miesiace (28+31+30=89 dni)
    for (const { from, to } of okna) {
      const rozpietoscDni = (new Date(to) - new Date(from)) / (1000 * 60 * 60 * 24);
      expect(rozpietoscDni).toBeLessThanOrEqual(92);
    }
    // sanity check: okna nadal pokrywaja caly zakres bez dziur
    expect(okna[0].from).toBe('2026-01-31T00:00:00.000Z');
    expect(okna[okna.length - 1].to).toBe('2026-12-31T00:00:00.000Z');
    for (let i = 1; i < okna.length; i++) {
      expect(okna[i].from).toBe(okna[i - 1].to);
    }
  });

  it('⚠️ obciecie bez ostatniaData rzuca zamiast po cichu gubic dane', () => {
    expect(() => nastepnyKrok({ hasMore: true, isTruncated: true, pageOffset: 40, ostatniaData: undefined }))
      .toThrow();
  });
});
