import { describe, it, expect } from 'vitest';
import { mapujZamowienie } from '../../src/domena/mapowanie.js';

// DATY ZAMOWIENIA W UTC Z SUFIKSEM `Z` — naprawa skazenia z audytu 22.08.2026.
//
// Woo oddaje DWIE wersje kazdej daty: `date_created` (czas LOKALNY sklepu, bez oznaczenia
// strefy) i `date_created_gmt` (UTC — ale TEZ bez `Z` na koncu!). Mapowanie bralo wersje
// lokalna, wiec kanaly Woo pisaly do bazy czas warszawski, a Allegro i reczne — UTC z `Z`.
// Zmierzone na produkcji: 53 zamowienia z czasem nagim, 3 z UJEMNYM czasem do nadania,
// kazde porownanie dat miedzy kanalami w SQL bledne o 2 h.
//
// Regula: GMT z dolozonym `Z`; wersja lokalna WYLACZNIE gdy GMT nie przyszlo (stare
// payloady) — wtedy bez zmian, a wiersz domknie backfill (db/zamowienia.js).

const surowe = (nad = {}) => ({
  id: 1278, number: '1278', total: '174.80', status: 'processing',
  payment_method: 'bacs', payment_method_title: 'Przelew tradycyjny',
  billing: {}, shipping: {}, line_items: [], shipping_lines: [], meta_data: [],
  ...nad,
});

describe('mapowanie dat Woo na UTC', () => {
  it('utworzone_at bierze date_created_gmt i doklada Z', () => {
    const z = mapujZamowienie(surowe({
      date_created: '2026-07-30T13:32:22',
      date_created_gmt: '2026-07-30T11:32:22',
    }), {});
    expect(z.utworzone_at).toBe('2026-07-30T11:32:22Z');
  });

  it('oplacone_at bierze date_paid_gmt i doklada Z', () => {
    const z = mapujZamowienie(surowe({
      date_paid: '2026-07-30T13:50:26',
      date_paid_gmt: '2026-07-30T11:50:26',
    }), {});
    expect(z.oplacone_at).toBe('2026-07-30T11:50:26Z');
  });

  it('GMT z juz obecnym Z nie dostaje drugiego', () => {
    const z = mapujZamowienie(surowe({ date_created_gmt: '2026-07-30T11:32:22Z' }), {});
    expect(z.utworzone_at).toBe('2026-07-30T11:32:22Z');
  });

  // Payload bez wersji GMT (starsze Woo / atrapa w tescie) — zachowanie sprzed zmiany,
  // bez zgadywania strefy: przeliczanie lokalnego czasu w mapowaniu byloby DRUGIM miejscem
  // liczacym czas Warszawy, a ten projekt przejechal sie na strefach juz dwa razy.
  it('bez GMT zostaje wersja lokalna, nietknieta', () => {
    const z = mapujZamowienie(surowe({ date_created: '2026-07-30T13:32:22' }), {});
    expect(z.utworzone_at).toBe('2026-07-30T13:32:22');
  });

  it('brak obu dat oddaje null, nie pusty napis', () => {
    const z = mapujZamowienie(surowe({ date_paid: null }), {});
    expect(z.oplacone_at).toBe(null);
  });
});
