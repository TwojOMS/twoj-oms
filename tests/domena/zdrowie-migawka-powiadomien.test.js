import { describe, it, expect } from 'vitest';
import { ocenZdrowie, PROG_POWIADOMIEN_S } from '../../src/domena/zdrowie.js';

// Migawka powiadomień liczy się w tle — bez śladu w /health zatrzymany zegar albo stały błąd zbierania
// wyglądałby z zewnątrz jak „brak spraw", bo dzwonek pokazuje ostatnią udaną migawkę.

const TERAZ = new Date('2026-11-18T10:00:00.000Z');
const temu = (s) => new Date(TERAZ.getTime() - s * 1000).toISOString();
const ocen = (nad = {}) =>
  ocenZdrowie({ teraz: TERAZ, startAt: temu(24 * 3600), zrodla: [], stanyPollera: [], ...nad });

describe('ocenZdrowie — migawka powiadomień (stan w bazie)', () => {
  it('skład bez modułu zamówień: wyłączona, bez alarmu', () => {
    const w = ocen();
    expect(w.czuwaczPowiadomien).toEqual({
      wlaczony: false,
      zdrowy: true,
      odswiezoneAt: null,
      wiekS: null,
      czasMs: null,
      blad: null,
      bladAt: null,
    });
    expect(w.ok).toBe(true);
  });

  it('świeży przebieg: zdrowa, z wiekiem i czasem przebiegu', () => {
    const w = ocen({
      powiadomieniaWlaczone: true,
      stanPowiadomien: { odswiezone_at: temu(45), czas_ms: 12, blad: null, blad_at: null },
    });
    expect(w.czuwaczPowiadomien).toMatchObject({ wlaczony: true, zdrowy: true, wiekS: 45, czasMs: 12 });
    expect(w.ok).toBe(true);
  });

  it('jeszcze bez przebiegu (tuż po starcie): bez alarmu', () => {
    const w = ocen({ powiadomieniaWlaczone: true, stanPowiadomien: null });
    expect(w.czuwaczPowiadomien.zdrowy).toBe(true);
    expect(w.ok).toBe(true);
  });

  it('błąd ostatniego przebiegu = alarm, nawet gdy poprzednia migawka jest świeża', () => {
    const w = ocen({
      powiadomieniaWlaczone: true,
      stanPowiadomien: { odswiezone_at: temu(60), czas_ms: 8, blad: 'baza zablokowana', blad_at: temu(5) },
    });
    expect(w.czuwaczPowiadomien).toMatchObject({ zdrowy: false, blad: 'baza zablokowana', bladAt: temu(5) });
    expect(w.ok).toBe(false);
    expect(w.alarmy).toContain('migawka powiadomień: baza zablokowana');
  });

  it('przebieg starszy niż próg = alarm (zegar stanął)', () => {
    expect(PROG_POWIADOMIEN_S).toBe(10 * 60);
    const stary = ocen({
      powiadomieniaWlaczone: true,
      stanPowiadomien: { odswiezone_at: temu(PROG_POWIADOMIEN_S + 1), czas_ms: 8, blad: null, blad_at: null },
    });
    expect(stary.czuwaczPowiadomien.zdrowy).toBe(false);
    expect(stary.alarmy).toEqual(['migawka powiadomień: ostatnie przeliczenie 10 min temu (próg 10 min)']);
    const naProgu = ocen({
      powiadomieniaWlaczone: true,
      stanPowiadomien: { odswiezone_at: temu(PROG_POWIADOMIEN_S), czas_ms: 8, blad: null, blad_at: null },
    });
    expect(naProgu.ok).toBe(true);
  });

  it('nowe pole stoi po czuwaczu kosztów, przed kanałami — umowa kolejności z czujką zostaje', () => {
    const klucze = Object.keys(ocen());
    expect(klucze.slice(klucze.indexOf('czuwaczKosztow'), klucze.indexOf('kanaly') + 1)).toEqual([
      'czuwaczKosztow',
      'czuwaczPowiadomien',
      'kanaly',
    ]);
    expect(klucze.slice(0, 4)).toEqual(['ok', 'alarmy', 'uwagi', 'poller']);
  });
});
