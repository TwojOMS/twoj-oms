import { expect, it, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { createCzuwaczPodjazdow } from '../../../src/moduly/wysylka/services/czuwacz-podjazdow.js';

it('odczytuje nierozstrzygniętą komendę oraz starą nieprzejętą paczkę WzA', async () => {
  const db = openOmsDb();
  db.prepare(`INSERT INTO zamowienia (sklep,zrodlo_id,numer,utworzone_at,kwota_brutto)
    VALUES ('allegro_szkicownia',1,'A1','2026-08-01T08:00:00Z','0')`).run();
  const zid = db.prepare('SELECT id FROM zamowienia').get().id;
  db.prepare(`INSERT INTO przesylki (zamowienie_id,kurier,status,numer_listu,utworzona_at,odpowiedz_surowa)
    VALUES (?,'allegro_wza','nadana','AD-1','2026-08-01T08:00:00Z',?)`)
    .run(zid, JSON.stringify({ carrier: 'ALLEGRO', packages: [{ waybill: 'AD-1' }] }));
  db.prepare(`INSERT INTO podjazdy_podglady (id,snapshot_json,wygasa_at,utworzony_at)
    VALUES ('preview','{}','2026-09-22T13:00:00Z','2026-09-22T10:00:00Z')`).run();
  db.prepare(`INSERT INTO podjazdy
    (podglad_id,grupa_id,command_id,kanal,przewoznik,adres_json,termin_json,stan,utworzony_at)
    VALUES ('preview','group','cmd','allegro_szkicownia','method','{}','{}','oczekuje','2026-09-22T10:00:00Z')`).run();
  const sprawdz = vi.fn(async () => ({ stan: 'oczekuje' }));
  const statusPrzesylki = vi.fn(async () => ({ opis: 'PENDING', kod: 'PENDING', historia: [] }));
  const czuwacz = createCzuwaczPodjazdow({ db, podjazdy: { sprawdz },
    kurierzy: { allegro: { statusPrzesylki } },
    teraz: () => new Date('2026-09-22T12:00:00Z') });
  await czuwacz.przebieg();
  expect(sprawdz).toHaveBeenCalledTimes(1);
  expect(statusPrzesylki).toHaveBeenCalledTimes(1);
});
