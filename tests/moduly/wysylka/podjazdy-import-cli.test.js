import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';

it('operacyjny import DPD jest powtarzalny i nie zleca drugiego podjazdu', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'oms-import-pickup-')), 'oms.sqlite');
  const db = openOmsDb(path);
  const z = db.prepare(`INSERT INTO zamowienia
    (sklep,zrodlo_id,numer,utworzone_at,kwota_brutto,metoda_wysylki)
    VALUES ('allegro_szkicownia',1,'A1','2026-09-22T08:00:00Z','0','allegro_dpd')`).run();
  const p = db.prepare(`INSERT INTO przesylki
    (zamowienie_id,kurier,status,numer_listu,id_przesylki_kuriera,etykieta_zpl_sciezka,utworzona_at)
    VALUES (?,'allegro_wza','nadana','AD-1','shipment-1','/data/A.zpl','2026-09-22T08:00:00Z')`).run(Number(z.lastInsertRowid));
  const id = Number(p.lastInsertRowid);
  db.close();
  const script = resolve('scripts/oms-import-istniejacy-podjazd-dpd.mjs');
  const args = [script, String(id), 'allegro_szkicownia', 'shipment-1', 'AD-1',
    'command-1', 'pickup-1', 'AD-100', '2026-09-23', '13:00', '17:00'];
  const env = { ...process.env, OMS_DB_PATH: path, DPD_NADAWCA_NAZWA: 'Firma',
    DPD_NADAWCA_ULICA: 'Polna 1', DPD_NADAWCA_KOD: '32-600',
    DPD_NADAWCA_MIASTO: 'Pęki', DPD_NADAWCA_TELEFON: '500600700',
    DPD_NADAWCA_EMAIL: 'firma@example.com' };
  const uruchom = () => JSON.parse(execFileSync(process.execPath, args, { env, encoding: 'utf8' }));
  expect(uruchom()).toMatchObject({ stan: 'potwierdzony', pickupId: 'pickup-1', pickupCarrier: 'DPD' });
  expect(uruchom().pickupId).toBe('pickup-1');
  const po = openOmsDb(path);
  expect(po.prepare('SELECT COUNT(*) c FROM podjazdy').get().c).toBe(1);
  expect(po.prepare('SELECT COUNT(*) c FROM podjazdy_przesylki WHERE aktywna_rezerwacja=1').get().c).toBe(1);
  po.close();
});
