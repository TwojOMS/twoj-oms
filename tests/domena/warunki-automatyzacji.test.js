// PRZ-108.08 (zmiana C1 planu automatyzacji, test 10): warunki reguły sprawdzane w chwili wykonania — czysta funkcja.
// Każdy warunek osobno spełniony i niespełniony; status własny przy `wyslane_at`; pusty zestaw statusów = dowolny.
import { describe, it, expect } from 'vitest';
import { sprawdzWarunki, opisWarunkow, historiaPrzedGranica } from '../../src/domena/warunki-automatyzacji.js';

const WLASNE = [{ klucz: 'w_klosz', etykieta: 'Czeka na klosz', jak: 'w_realizacji' }];
const zam = (o = {}) => ({ id: 1, anulowane: 0, wyslane_at: null, w_realizacji_at: null, zwrot_at: null, ma_zwrot: false,
  status_wlasny: null, statusy_wlasne: WLASNE, etykiety_statusow: { w_klosz: 'Czeka na klosz', wyslane: 'Wysłane' },
  metoda_wysylki: 'dpd', pobranie: 0, przesylki: [], ...o });
const PACZKA = { kurier: 'dpd', status: 'nadana', numer_listu: '0000000000119U' };

describe('sprawdzWarunki — status jest jednym z …', () => {
  it('pusty zestaw statusów = dowolny', () => {
    expect(sprawdzWarunki(zam(), {}).ok).toBe(true);
    expect(sprawdzWarunki(zam(), { statusy: [] }).ok).toBe(true);
  });
  it('Wysłane spełnione; W realizacji (cofnięte) niespełnione z powodem i kodem „warunek”', () => {
    expect(sprawdzWarunki(zam({ wyslane_at: '2026-10-21T10:00:00Z' }), { statusy: ['wyslane'] }).ok).toBe(true);
    const w = sprawdzWarunki(zam({ w_realizacji_at: '2026-10-21T09:00:00Z' }), { statusy: ['wyslane'] });
    expect(w).toEqual({ ok: false, kod: 'warunek', powod: expect.stringContaining('Status jest teraz W realizacji') });
    expect(w.powod).toContain('warunek „status jest Wysłane” przestał być spełniony');
  });
  it('status własny przy `wyslane_at` → wyliczStatus = wysłane, więc „status jest Czeka na klosz” NIESPEŁNIONY', () => {
    const z = zam({ wyslane_at: '2026-10-21T10:00:00Z', w_realizacji_at: '2026-10-20T10:00:00Z', status_wlasny: 'w_klosz' });
    const w = sprawdzWarunki(z, { statusy: ['w_klosz'] });
    expect(w.ok).toBe(false);
    expect(w.powod).toContain('Status jest teraz Wysłane');
    expect(w.powod).toContain('„status jest Czeka na klosz”');
    // bez wyslane_at ten sam status własny jest spełniony
    expect(sprawdzWarunki({ ...z, wyslane_at: null }, { statusy: ['w_klosz'] }).ok).toBe(true);
  });
  it('anulowane, zwrot i nowe liczone tak jak na liście zamówień', () => {
    expect(sprawdzWarunki(zam({ anulowane: 1, wyslane_at: '2026-10-21T10:00:00Z' }), { statusy: ['wyslane'] }).ok).toBe(false);
    expect(sprawdzWarunki(zam({ ma_zwrot: true }), { statusy: ['zwrot'] }).ok).toBe(true);
    expect(sprawdzWarunki(zam(), { statusy: ['nowe', 'w_realizacji'] }).ok).toBe(true);
  });
});

describe('sprawdzWarunki — przesyłka ma numer listu', () => {
  it('paczka nadana z numerem → spełniony; bez paczki → niespełniony', () => {
    expect(sprawdzWarunki(zam({ przesylki: [PACZKA] }), { maNumerListu: true }).ok).toBe(true);
    const w = sprawdzWarunki(zam(), { maNumerListu: true });
    expect(w.ok).toBe(false);
    expect(w.powod).toContain('nie ma paczki z numerem listu');
  });
  it('paczka „do wyjaśnienia” albo bez numeru się nie liczy (ta sama reguła co mail „Zamówienie wysłane”)', () => {
    expect(sprawdzWarunki(zam({ przesylki: [{ ...PACZKA, status: 'do_wyjasnienia' }] }), { maNumerListu: true }).ok).toBe(false);
    expect(sprawdzWarunki(zam({ przesylki: [{ ...PACZKA, numer_listu: '  ' }] }), { maNumerListu: true }).ok).toBe(false);
  });
  it('maNumerListu false / brak → bez znaczenia', () => {
    expect(sprawdzWarunki(zam(), { maNumerListu: false }).ok).toBe(true);
  });
});

describe('sprawdzWarunki — dostawa i pobranie', () => {
  it('sposób dostawy z listy: DPD spełniony, paczkomat nie; ręczna zmiana na karcie wygrywa', () => {
    expect(sprawdzWarunki(zam(), { metody: ['dpd'] }).ok).toBe(true);
    const w = sprawdzWarunki(zam(), { metody: ['inpost_paczkomat'] });
    expect(w.ok).toBe(false);
    expect(w.powod).toContain('Kurier DPD');
    const reczna = zam({ wysylka_reczna_json: JSON.stringify({ metoda: 'inpost_paczkomat', pobranie: 0 }) });
    expect(sprawdzWarunki(reczna, { metody: ['inpost_paczkomat'] }).ok).toBe(true);
  });
  it('pobranie: tylko za pobraniem / tylko bez / dowolne', () => {
    const cod = zam({ pobranie: 1 });
    expect(sprawdzWarunki(cod, { pobranie: 'tak' }).ok).toBe(true);
    expect(sprawdzWarunki(zam(), { pobranie: 'tak' }).ok).toBe(false);
    expect(sprawdzWarunki(cod, { pobranie: 'nie' }).ok).toBe(false);
    expect(sprawdzWarunki(zam(), { pobranie: 'nie' }).ok).toBe(true);
    expect(sprawdzWarunki(cod, { pobranie: 'dowolne' }).ok).toBe(true);
  });
  it('kilka warunków naraz — pierwszy niespełniony daje powód', () => {
    const w = sprawdzWarunki(zam({ wyslane_at: '2026-10-21T10:00:00Z' }), { statusy: ['wyslane'], maNumerListu: true });
    expect(w.powod).toContain('nie ma paczki z numerem listu');
  });
  it('brak zamówienia → niespełniony', () => {
    expect(sprawdzWarunki(null, {}).ok).toBe(false);
  });
});

describe('opisWarunkow', () => {
  it('zdanie dla człowieka; brak warunków = pusty tekst', () => {
    expect(opisWarunkow({})).toBe('');
    expect(opisWarunkow({ statusy: ['wyslane'], maNumerListu: true })).toBe('ma status Wysłane i ma paczkę z numerem listu');
    expect(opisWarunkow({ statusy: ['w_klosz'] }, { etykiety: { w_klosz: 'Czeka na klosz' } })).toBe('ma status Czeka na klosz');
  });
});

// PRZ-108.08b (recenzja 08, runda 2, R2-1): numer z Allegro dociągnięty ponad 14 dni po złożeniu zamówienia → pominięte.
describe('historiaPrzedGranica — numer z Allegro dociągnięty długo po złożeniu (R2-1)', () => {
  const GRANICA = { at: '2026-10-21T10:00:00.000Z', przesylki: 10 };
  const zAllegro = (zrodlo) => zam({ utworzone_at: '2026-10-25T10:00:00.000Z',
    przesylki: [{ ...PACZKA, id: 20, kurier: 'allegro', zrodlo_numeru: zrodlo, numer_listu: 'AD000999PL' }] });
  const wyk = (zdarzenie) => ({ przesylka_id: 20, zdarzenie_at: zdarzenie });
  it('numer z Allegro 60 dni po złożeniu → numer_allegro_pozno; 13 dni po → spełnione', () => {
    expect(historiaPrzedGranica(zAllegro('allegro'), GRANICA, { wykonanie: wyk('2026-12-24T10:00:00.000Z') }))
      .toMatchObject({ ok: false, kod: 'numer_allegro_pozno' });
    expect(historiaPrzedGranica(zAllegro('allegro'), GRANICA, { wykonanie: wyk('2026-11-07T10:00:00.000Z') })).toEqual({ ok: true });
  });
  it('paczka z panelu albo z ręki (zrodlo_numeru ≠ allegro) — bez zmian; zdarzenie bez paczki — bez zmian', () => {
    expect(historiaPrzedGranica(zAllegro('reka'), GRANICA, { wykonanie: wyk('2026-12-24T10:00:00.000Z') })).toEqual({ ok: true });
    expect(historiaPrzedGranica(zAllegro(null), GRANICA, { wykonanie: wyk('2026-12-24T10:00:00.000Z') })).toEqual({ ok: true });
    expect(historiaPrzedGranica(zAllegro('allegro'), GRANICA, { wykonanie: { przesylka_id: null, zdarzenie_at: '2026-12-24T10:00:00.000Z' } }))
      .toEqual({ ok: true });
  });
  it('bez granicy (podgląd „30 dni”) świeżość numeru z Allegro też obowiązuje', () => {
    expect(historiaPrzedGranica(zAllegro('allegro'), null, { wykonanie: wyk('2026-12-24T10:00:00.000Z') }))
      .toMatchObject({ ok: false, kod: 'numer_allegro_pozno' });
  });
});
