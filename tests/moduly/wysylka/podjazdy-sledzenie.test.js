import { expect, it, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { odswiezStatusKuriera } from '../../../src/moduly/wysylka/services/status-kuriera.js';

it('skan WzA zapisuje przejęcie raz, a pusta późniejsza odpowiedź go nie cofa', async () => {
  const db = openOmsDb();
  db.prepare(`INSERT INTO zamowienia (sklep, zrodlo_id, numer, utworzone_at, status_woo, kwota_brutto)
    VALUES ('allegro_szkicownia', 'Z1', 'Z1', '2026-09-22T08:00:00Z', 'processing', '0')`).run();
  const zid = db.prepare("SELECT id FROM zamowienia WHERE zrodlo_id='Z1'").get().id;
  db.prepare(`INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, utworzona_at, odpowiedz_surowa)
    VALUES (?, 'allegro_wza', 'nadana', 'AD-1', '2026-09-22T08:00:00Z', ?)`)
    .run(zid, JSON.stringify({ carrier: 'ALLEGRO', packages: [{ waybill: 'AD-1', transportingInfo: [{ carrierId: 'ALLEGRO_ONE_KURIER', carrierWaybill: 'ONE-1' }] }] }));
  const pid = db.prepare('SELECT id FROM przesylki WHERE zamowienie_id=?').get(zid).id;
  const z = { id: zid, sklep: 'allegro_szkicownia' };
  const klient = { statusPrzesylki: vi.fn()
    .mockResolvedValueOnce({ opis: 'Nieznany nowy opis', at: '2026-09-22T09:00:00Z', kod: 'NEW', historia: [
      { code: 'IN_TRANSIT', occurredAt: '2026-09-22T08:30:00Z' },
      { code: 'NEW', occurredAt: '2026-09-22T09:00:00Z' },
    ] })
    .mockResolvedValueOnce({ opis: 'Pusta historia', at: null, kod: null, historia: [] }) };
  const kurierzy = { allegro: klient };

  await odswiezStatusKuriera(db, kurierzy, z, db.prepare('SELECT * FROM przesylki WHERE id=?').get(pid), { terazMs: Date.parse('2026-09-22T10:00:00Z') });
  const pierwszy = db.prepare('SELECT przejeta_at, przejecie_kod FROM przesylki WHERE id=?').get(pid);
  expect(pierwszy.przejeta_at).toBeTruthy();
  expect(pierwszy.przejecie_kod).toBe('IN_TRANSIT');

  db.prepare('UPDATE przesylki SET status_kuriera_pobrany_at=? WHERE id=?').run('2026-09-22T08:00:00Z', pid);
  await odswiezStatusKuriera(db, kurierzy, z, db.prepare('SELECT * FROM przesylki WHERE id=?').get(pid), { terazMs: Date.parse('2026-09-22T12:00:00Z') });
  expect(db.prepare('SELECT przejeta_at, przejecie_kod FROM przesylki WHERE id=?').get(pid)).toEqual(pierwszy);
});
