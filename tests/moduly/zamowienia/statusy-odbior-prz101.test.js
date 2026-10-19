import { it, expect } from 'vitest';
import { nowyPanel, BASIC, post } from '../../pomoc/konta-prz068.js';
import { zapiszZamowienie, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { wyliczStatus } from '../../../src/domena/status.js';

const utworz = db => zapiszZamowienie(db, 'reczne', {
  zrodlo_id: 1, numer: 'LAMPA-1', kwota_brutto: '10.00', status_woo: 'processing',
  klient: {}, dostawa: {}, metoda_wysylki: 'dpd', oplacone_at: null, nip: null,
  kwota_pobrania: null, chce_fakture: 0, anulowane: 0,
  utworzone_at: '2026-10-18T12:00:00Z', pozycje: [],
}, {});

it('usunięcie zamówienia kaskadowo usuwa przypisanie statusu własnego', async () => {
  const { db, app } = nowyPanel();
  try {
    await app.ready();
    await post(app, '/ustawienia/statusy', BASIC, { akcja: 'dodaj', etykieta: 'Druk', kolor: 'fioletowy', jak: 'w_realizacji' });
    const id = utworz(db);
    await post(app, `/zamowienia/${id}/status`, BASIC, { status: 'w_druk' });
    expect(db.prepare('PRAGMA foreign_keys').get().foreign_keys).toBe(1);
    expect(db.prepare('SELECT * FROM zamowienia_status_wlasny').all()).toHaveLength(1);
    expect(() => db.prepare('DELETE FROM zamowienia WHERE id = ?').run(id)).not.toThrow();
    expect(db.prepare('SELECT * FROM zamowienia_status_wlasny').all()).toHaveLength(0);
  } finally { await app.close(); db.close(); }
});

it.each(['nowe', 'w_realizacji'])('akceptacja projektu zachowuje tylko etap własny jak w_realizacji (jak: %s)', async jak => {
  const { db, app } = nowyPanel();
  try {
    await app.ready();
    await post(app, '/ustawienia/statusy', BASIC, { akcja: 'dodaj', etykieta: 'Druk', kolor: 'fioletowy', jak });
    const id = utworz(db);
    await post(app, `/zamowienia/${id}/status`, BASIC, { status: 'w_druk' });
    const przypisanie = db.prepare('SELECT * FROM zamowienia_status_wlasny WHERE zamowienie_id = ?').get(id);
    for (let n = 0; n < 2; n++) {
      const res = await post(app, `/api/zamowienia/${id}/w-realizacji`, BASIC);
      expect(res.statusCode, res.body).toBe(200);
      const z = pobierzZamowienie(db, id);
      expect(z.w_realizacji_at).toBeTruthy();
      expect(wyliczStatus(z)).toBe(jak === 'w_realizacji' ? 'w_druk' : 'w_realizacji');
      expect(res.json().status).toBe(wyliczStatus(z));
      expect(db.prepare('SELECT * FROM zamowienia_status_wlasny WHERE zamowienie_id = ?').get(id))
        .toEqual(jak === 'w_realizacji' ? przypisanie : undefined);
    }
  } finally { await app.close(); db.close(); }
});
