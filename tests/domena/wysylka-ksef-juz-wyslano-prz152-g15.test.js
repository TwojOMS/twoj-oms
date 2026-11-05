// PRZ-152.G15 — krótkie zdanie po drugim zgłoszeniu i plakietka „Zlecono do KSeF” na karcie (właściciel 05.11.2026).
// Data jak w decyzji właściciela 4.11: `D.M GG:MM` w czasie Warszawy, inny rok → z rokiem (`kiedyRuchu`).
import { describe, it, expect } from 'vitest';
import { zdanieJuzWyslano, wysylkaZKarty, coWolnoWyslac, powodJuzZlecona } from '../../src/domena/wysylka-ksef.js';

const TERAZ = new Date('2026-11-05T12:00:00.000Z');
const testownik = { opis: { nazwa: { mianownik: 'Testownik', miejscownik: 'Testowniku', dopelniacz: 'Testownika' } } };

describe('zdanieJuzWyslano', () => {
  it('inFakt (domyślny): zdanie znak w znak z briefu', () => {
    expect(zdanieJuzWyslano('2026-11-05T07:22:00.000Z', undefined, TERAZ))
      .toBe('Ten dokument już wysłano do KSeF 5.11 08:22 — sprawdź go w inFakcie.');
  });
  it('inny rok → data z rokiem', () => {
    expect(zdanieJuzWyslano('2025-12-31T22:30:00.000Z', undefined, TERAZ))
      .toBe('Ten dokument już wysłano do KSeF 31.12.2025 23:30 — sprawdź go w inFakcie.');
  });
  it('inny program: nazwa z programu w miejscowniku', () => {
    expect(zdanieJuzWyslano('2026-11-05T07:22:00.000Z', testownik, TERAZ))
      .toBe('Ten dokument już wysłano do KSeF 5.11 08:22 — sprawdź go w Testowniku.');
  });
  it('program wbudowany: bez odsyłania do innego programu', () => {
    expect(zdanieJuzWyslano('2026-11-05T07:22:00.000Z', { opis: { wbudowany: true } }, TERAZ))
      .toBe('Ten dokument już wysłano do KSeF 5.11 08:22.');
  });
});

describe('wysylkaZKarty po zleceniu', () => {
  it('bez długiego powodu, z datą do plakietki', () => {
    const k = wysylkaZKarty({ uuid: 'u1', ksefNumer: null, nip: '1234563218', zleconaAt: '2026-11-05T07:22:00.000Z', dzienWystawienia: '2026-10-20' });
    expect(k.wolno).toBe(false);
    expect(k.stan).toBe('wyslana_czeka');
    expect(k.powod).toBeNull();
    expect(k.zlecono).toMatch(/^5\.11(\.\d{4})? 08:22$/);
  });
});

describe('blokada serwera bez zmian', () => {
  it('coWolnoWyslac nadal pomija zlecony dokument z długim powodem (log, automat) i znacznikiem do ekranu', () => {
    const d = { uuid: 'u1', number: '1/10/2026', rodzaj: 'vat', ksef_number: null, client_tax_code: '1234563218', ksefZleconaAt: '2026-11-05T07:22:00.000Z' };
    const w = coWolnoWyslac(['u1'], [d]);
    expect(w.doWyslania).toEqual([]);
    expect(w.pominiete).toHaveLength(1);
    expect(w.pominiete[0].powod).toBe(powodJuzZlecona(d.ksefZleconaAt));
    expect(w.pominiete[0].juzZlecona).toBe(true);
    expect(w.pominiete[0].zleconaAt).toBe(d.ksefZleconaAt);
  });
});
