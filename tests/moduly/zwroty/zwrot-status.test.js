import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie, listaZamowien } from '../../../src/oms/db/zamowienia.js';
import { dodajZwrot, oznaczPieniadzeOddane } from '../../../src/oms/db/zwroty.js';
import { wyliczStatus, doZrobienia } from '../../../src/domena/status.js';
import { STATUSY_RECZNE, powodOdmowyStatusu } from '../../../src/domena/status-reczny.js';

const zmapowane = (nad = {}) => ({
  zrodlo_id: 1301, numer: '1301', klient: { email: 'j@k.pl' }, dostawa: {},
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null,
  kwota_brutto: '212.90', status_woo: 'processing', oplacone_at: null, anulowane: 0,
  utworzone_at: '2026-07-29T13:19:52', pozycje: [],
  ...nad,
});

let db;
let id;
beforeEach(() => {
  db = openOmsDb(':memory:');
  // ⚠️ Rozbieznosc z briefem: `zapiszZamowienie` oddaje LICZBOWE `id` wprost (return id
  // w db/zamowienia.js), nie obiekt { id }. Brief mial tu `.id` — usuniete z tego samego
  // powodu, co w tests/oms/zwroty-db.test.js: `(liczba).id` dawaloby `undefined`.
  id = zapiszZamowienie(db, 'pro', zmapowane(), {});
});

describe('status wynika ze zwrotu', () => {
  it('zwrot CZESCIOWY tez daje status „zwrot”', () => {
    dodajZwrot(db, id, { data: '2026-08-14', kwota: '50.00', pozycje: [] });
    expect(wyliczStatus(pobierzZamowienie(db, id))).toBe('zwrot');
  });

  it('LISTA liczy ten sam status, co karta — bez pytania per wiersz', () => {
    dodajZwrot(db, id, { data: '2026-08-14', kwota: '50.00', pozycje: [] });
    const wiersz = listaZamowien(db).find((w) => w.id === id);
    expect(wyliczStatus(wiersz)).toBe('zwrot');
  });

  it('stary `zwrot_at` bez wpisu NADAL daje status „zwrot”', () => {
    expect(wyliczStatus({ zwrot_at: '2026-07-01T10:00:00Z' })).toBe('zwrot');
  });

  it('anulowanie wygrywa ze zwrotem', () => {
    expect(wyliczStatus({ anulowane: 1, ma_zwrot: true })).toBe('anulowane');
  });
});

describe('lista robocza', () => {
  it('zwrot z NIEODDANYMI pieniedzmi zostaje na liscie roboczej mimo koncowego statusu', () => {
    dodajZwrot(db, id, { data: '2026-08-14', kwota: '50.00', pozycje: [] });
    expect(doZrobienia(pobierzZamowienie(db, id))).toBe(true);
  });

  it('zwrot rozliczony schodzi z listy roboczej', () => {
    const w = dodajZwrot(db, id, { data: '2026-08-14', kwota: '50.00', pozycje: [] });
    oznaczPieniadzeOddane(db, id, w.id, '2026-08-15T09:00:00Z');
    expect(doZrobienia(pobierzZamowienie(db, id))).toBe(false);
  });

  // ⚠️ Dwa testy nizej NIE SA w briefie (Zadanie 3, Krok 1) — dopisane po tym, jak proba
  // zweryfikowania „lista robocza" NA LISCIE (nie tylko na karcie) wykazala rozjazd: brief
  // kazal liscie niesc WYLACZNIE `ma_zwrot` (flaga z jednego zapytania), ale `doZrobienia`
  // liczy `(z.zwroty ?? []).some((w) => !zwrotRozliczony(z, w))` — a bez PELNYCH naglowkow
  // zwrotu na wierszu listy ten warunek zawsze wychodzil `false`, wiec zamowienie z
  // NIEODDANYMI pieniedzmi znikalo z listy roboczej natychmiast po zarejestrowaniu zwrotu,
  // zamiast czekac na rozliczenie — dokladnie to, czego to zadanie mialo pilnowac.
  // Naprawa: `listaZamowien` (db/zamowienia.js) niesie dzis naglowki zwrotow (bez pozycji,
  // JEDNYM zapytaniem — `zwrotyDlaZamowien` w db/zwroty.js), nie sama flage.
  it('LISTA (nie tylko karta) trzyma nierozliczony zwrot na liscie roboczej', () => {
    dodajZwrot(db, id, { data: '2026-08-14', kwota: '50.00', pozycje: [] });
    const wiersz = listaZamowien(db).find((w) => w.id === id);
    expect(doZrobienia(wiersz)).toBe(true);
  });

  it('LISTA (nie tylko karta) zdejmuje zwrot rozliczony z listy roboczej', () => {
    const w = dodajZwrot(db, id, { data: '2026-08-14', kwota: '50.00', pozycje: [] });
    oznaczPieniadzeOddane(db, id, w.id, '2026-08-15T09:00:00Z');
    const wiersz = listaZamowien(db).find((w2) => w2.id === id);
    expect(doZrobienia(wiersz)).toBe(false);
  });
});

describe('reczne przestawianie statusu', () => {
  it('„zwrot” zniknal z listy statusow ustawianych recznie', () => {
    expect(STATUSY_RECZNE).not.toContain('zwrot');
  });

  it('zamowienie ZE ZWROTEM odmawia recznej zmiany statusu, zamiast jej udawac', () => {
    const powod = powodOdmowyStatusu({ ma_zwrot: true }, 'w_realizacji');
    expect(powod).toMatch(/zwrot/i);
  });

  it('stare `zwrot_at` BEZ wpisu wolno dalej przestawic — nie ma czego kasowac', () => {
    expect(powodOdmowyStatusu({ zwrot_at: '2026-07-01T10:00:00Z', ma_zwrot: false }, 'w_realizacji')).toBeNull();
  });
});
