import { describe, it, expect } from 'vitest';
import { wyliczStatus, doZrobienia, ETYKIETY } from '../../src/domena/status.js';
import { faktyDlaStatusu, powodOdmowyStatusu } from '../../src/domena/status-reczny.js';
import { statusDlaAllegro } from '../../src/domena/allegro-status.js';
import { statusDlaSklepu } from '../../src/domena/sync-sklep.js';

const definicja = { klucz: 'w_do_pakowania', etykieta: 'Do pakowania', kolor: 'fioletowy', jak: 'w_realizacji' };
const z = (dodatki = {}) => ({ status_wlasny: definicja.klucz, statusy_wlasne: [definicja], ...dodatki });

describe('status własny — fakty i świat zewnętrzny', () => {
  it('własny wygrywa z etapami pośrednimi i pozostaje do zrobienia', () => {
    expect(wyliczStatus(z({ w_realizacji_at: '2026-10-18', indywidualne: 1 }))).toBe(definicja.klucz);
    expect(doZrobienia(z())).toBe(true);
  });
  it.each([{ anulowane: 1 }, { ma_zwrot: true }, { zwrot_at: '2026-10-18' }, { wyslane_at: '2026-10-18' }])('fakt końcowy %j wygrywa z własnym', (fakt) => {
    expect(wyliczStatus(z(fakt))).toBe(wyliczStatus(fakt));
  });
  it('ignoruje usuniętą definicję', () => {
    expect(wyliczStatus(z({ statusy_wlasne: [] }))).toBe('nowe');
  });
  it('ręczny własny zapisuje fakty jak W realizacji', () => {
    expect(powodOdmowyStatusu(z(), definicja.klucz)).toBe(null);
    expect(faktyDlaStatusu(z(), definicja.klucz, { teraz: 'dzis' })).toMatchObject({
      w_realizacji_at: 'dzis', wyslane_at: null, status_wlasny: definicja.klucz,
    });
  });
  it.each([['nowe', 'NEW'], ['w_realizacji', 'PROCESSING']])('jak %s mapuje do Allegro %s, nigdy klucza własnego', (jak, status) => {
    const zam = z({ sklep: 'allegro_test', zrodlo_id: 'test', statusy_wlasne: [{ ...definicja, jak }] });
    expect(statusDlaAllegro(zam, null)).toBe(status);
    expect(statusDlaAllegro(zam, status)).toBe(null);
    expect(statusDlaSklepu({ ...zam, sklep: 'sklep', kanal: 'woo' })).toBe(null);
  });
  it('bez konfiguracji zachowuje nazwy i kolejność', () => {
    expect(Object.entries(ETYKIETY)).toEqual([['nowe', 'Nowe'], ['indywidualne', 'Indywidualne'], ['w_realizacji', 'W realizacji'], ['wyslane', 'Wysłane'], ['zwrot', 'Zwrot'], ['anulowane', 'Anulowane']]);
  });
});
