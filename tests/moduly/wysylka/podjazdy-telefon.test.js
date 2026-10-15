import { afterEach, expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { createPodjazdy } from '../../../src/moduly/wysylka/services/podjazdy.js';
import { createAllegroClient } from '../../../src/oms/allegro/client.js';

const adres = { name: 'Test', street: 'Testowa 1', postalCode: '00-001', city: 'Test',
  countryCode: 'PL', email: 'test@example.invalid', phone: '501234567' };
const termin = { date: '2026-10-09', minTime: '09:00', maxTime: '13:00' };
const bazy = [];
afterEach(() => { for (const db of bazy.splice(0)) db.close(); });

function przygotujUsluge(telefonOdpowiedzi) {
  const db = openOmsDb();
  bazy.push(db);
  const z = db.prepare(`INSERT INTO zamowienia (sklep,zrodlo_id,numer,utworzone_at,kwota_brutto)
    VALUES ('allegro_test',1,'TEST-055','2026-10-08T08:00:00Z','0')`).run();
  const p = db.prepare(`INSERT INTO przesylki
    (zamowienie_id,kurier,status,numer_listu,id_przesylki_kuriera,etykieta_sciezka,utworzona_at,kolejnosc)
    VALUES (?,'allegro_wza','nadana','TEST-LIST','shipment-055','test.pdf','2026-10-08T08:00:00Z',1)`)
    .run(z.lastInsertRowid);
  const zadania = [];
  const klient = createAllegroClient({
    ustawienia: { api: 'https://allegro.example.invalid', userAgent: 'Test/1.0' },
    tokeny: { waznyToken: async () => 'TEST-TOKEN' },
    fetchImpl: async (url, opcje) => {
      const body = opcje.body ? JSON.parse(opcje.body) : null;
      zadania.push({ url, metoda: opcje.method, body });
      if (url.endsWith('/shipments/shipment-055')) return { ok: true, json: async () => ({
        id: 'shipment-055', deliveryMethodId: '03f26351-f683-4db2-8895-f2c599280e3c',
        transport: ['DPD'], pickupAvailable: true, packages: [{ waybill: 'TEST-LIST' }],
      }) };
      if (url.endsWith('/pickup-proposals')) return { ok: true, json: async () => [{
        address: { ...body.address, phone: telefonOdpowiedzi ?? body.address.phone, company: null, state: null },
        proposals: [{ shipmentId: 'shipment-055', pickupTimes: [termin] }],
      }] };
      if (url.endsWith('/pickups/create-commands')) return { ok: true, json: async () => ({ status: 'IN_PROGRESS' }) };
      throw new Error(`Nieoczekiwane lokalne zapytanie ${url}`);
    },
  });
  let nr = 0;
  const usluga = createPodjazdy({ db, allegroDla: () => klient,
    teraz: () => new Date('2026-10-08T10:00:00Z'), uuid: () => `test-055-${++nr}`, moznaZlecac: true });
  return { db, usluga, zadania, ids: [Number(p.lastInsertRowid)] };
}

it.each([
  ['PL', '501234567', '+48501234567'],
  ['PL', ' (501) 234-567 ', '+48501234567'],
  ['PL', '0048501234567', '+48501234567'],
  ['PL', '00 48 (501) 234-567', '+48501234567'],
  ['PL', ' +48 501 234 567 ', '+48501234567'],
  ['PL', '+49 (123)-456 789', '+49(123)-456789'],
  ['DE', '501234567', '501234567'],
  ['DE', '(501) 234-567', '(501) 234-567'],
  ['PL', '50123456', '50123456'],
  ['PL', '5012345678', '5012345678'],
  ['PL', '48 501 234 567', '48 501 234 567'],
  ['PL', '501ABC567', '501ABC567'],
])('telefon %s / %s: ten sam numer w HTTP i snapshotcie', async (countryCode, phone, wynik) => {
  const { db, usluga, ids, zadania } = przygotujUsluge();
  const wejscie = { ...adres, countryCode, phone };
  const podglad = await usluga.przygotuj({ ids, data: termin.date, adres: wejscie });
  expect(zadania.find((z) => z.body)?.body.address.phone).toBe(wynik);
  expect(podglad.adres.phone).toBe(wynik);
  const snapshot = JSON.parse(db.prepare('SELECT snapshot_json FROM podjazdy_podglady WHERE id=?')
    .get(podglad.id).snapshot_json);
  expect(snapshot.adres.phone).toBe(wynik);
  expect(wejscie.phone).toBe(phone);
});

it('Allegro z +48 i opcjonalnymi null daje terminy, a zlecenie używa adresu ze snapshotu', async () => {
  const { db, usluga, ids, zadania } = przygotujUsluge('+48501234567');
  const podglad = await usluga.przygotuj({ ids, data: termin.date, adres });
  expect(podglad.grupy[0].terminy).toEqual([termin]);
  expect(podglad.grupy[0].diagnoza).toBeNull();
  expect(usluga.pobierzPodglad({ id: podglad.id }).adres.phone).toBe('+48501234567');
  const zlecenie = await usluga.zlec({ podgladId: podglad.id, grupaId: podglad.grupy[0].id, termin });
  expect(zlecenie.stan).toBe('oczekuje');
  expect(zadania.filter((z) => z.url.endsWith('/pickup-proposals')).map((z) => z.body.address.phone))
    .toEqual(['+48501234567', '+48501234567']);
  expect(zadania.find((z) => z.url.endsWith('/pickups/create-commands')).body.input.address.phone)
    .toBe('+48501234567');
  const zapis = db.prepare('SELECT adres_json FROM podjazdy WHERE id=?').get(zlecenie.id);
  expect(JSON.parse(zapis.adres_json).phone).toBe('+48501234567');
});

it('inny telefon odesłany przez Allegro nadal blokuje terminy', async () => {
  const { usluga, ids } = przygotujUsluge('+48501999999');
  const podglad = await usluga.przygotuj({ ids, data: termin.date, adres });
  expect(podglad.grupy[0].terminy).toEqual([]);
  expect(podglad.grupy[0].diagnoza.przyczyna).toBe('niezgodny-adres');
});
