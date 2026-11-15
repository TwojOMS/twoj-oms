// PRZ-160 P4.02 (punkt 23) — podjazd kuriera dla Allegro One.
// Pomiar 13.11.2026 (tylko GET zasobu przesyłki): obie usługi One podają transport ['ALLEGRO_ONE_KURIER'],
// pickupAvailable: true. Propozycje terminów dla One niezmierzone — puste `pickupTimes` obsłużone ogólnie
// (zlecenie z samą datą). Wszystko na atrapach: żadnego połączenia z Allegro.
import { describe, expect, it, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { createPodjazdy } from '../../../src/moduly/wysylka/services/podjazdy.js';
import { ofertyPodjazdu, diagnozaTerminow, podjazdPoTerminie, opisTerminu, nazwaKuriera } from '../../../src/domena/podjazdy.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { createAtrapaAllegro } from '../../../deploy/proba/atrapy/kanaly.mjs';
import { ENV_DEMO } from '../../../scripts/demo-dane.mjs';

const ONE_KURIER = '0d83955a-4297-4169-adef-9790d53b11ff';
const ONE_BOX = '0b9bed2c-0bc1-4e1f-9694-29bb39ebb483';
const DPD_WZA = '03f26351-f683-4db2-8895-f2c599280e3c';
const adres = { name: 'Pracownia Półcień', street: 'Przykładowa 1', postalCode: '00-001', city: 'Warszawa',
  countryCode: 'PL', email: 'nadawca@example.test', phone: '+48500100200' };
const termin = { date: '2026-09-23', minTime: '10:00', maxTime: '14:00' };
const zegar = () => new Date('2026-09-22T12:00:00Z');
const auth = { authorization: `Basic ${Buffer.from('adam:x').toString('base64')}` };

// Przesyłki: shipment-N ma metodę i transport z `uslugi[shipment]`.
function dane(uslugi) {
  const db = openOmsDb();
  db.prepare(`INSERT INTO zamowienia (sklep,zrodlo_id,numer,utworzone_at,kwota_brutto)
    VALUES ('allegro_polcien',1,'A1','2026-09-22T08:00:00Z','0')`).run();
  const z = db.prepare('SELECT id FROM zamowienia WHERE numer=?').get('A1');
  const dodaj = db.prepare(`INSERT INTO przesylki
    (zamowienie_id,kurier,status,numer_listu,id_przesylki_kuriera,etykieta_sciezka,utworzona_at,kolejnosc)
    VALUES (?,'allegro_wza','nadana',?,?,'etykieta.pdf','2026-09-22T08:00:00Z',?)`);
  Object.keys(uslugi).forEach((shipment, i) => dodaj.run(z.id, `AO-${i + 1}`, shipment, i + 1));
  const ids = db.prepare('SELECT id FROM przesylki ORDER BY id').all().map((w) => w.id);
  return { db, ids };
}

function klient(uslugi, { terminy = () => [termin] } = {}) {
  const numery = Object.fromEntries(Object.keys(uslugi).map((s, i) => [s, `AO-${i + 1}`]));
  return {
    pobierzPrzesylkeWza: vi.fn(async (id) => ({ id, carrier: 'ALLEGRO', deliveryMethodId: uslugi[id][0],
      transport: uslugi[id][1], pickupAvailable: true, packages: [{ waybill: numery[id] }] })),
    pobierzPropozycjePodjazdu: vi.fn(async ({ shipmentIds, address }) => [{
      address, proposals: shipmentIds.map((shipmentId) => ({ shipmentId, pickupTimes: terminy(shipmentId) })),
    }]),
    zlecPodjazd: vi.fn(async () => ({ status: 'IN_PROGRESS' })),
    stanZleceniaPodjazdu: vi.fn(async () => ({ status: 'IN_PROGRESS' })),
  };
}

const ustaw = (db, klucz, wartosc) => db.prepare(`INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES (?,?,?)
  ON CONFLICT(klucz) DO UPDATE SET wartosc=excluded.wartosc`).run(klucz, wartosc, '2026-09-22T12:00:00Z');
const usluga = (db, allegro) => {
  let i = 0;
  return createPodjazdy({ db, teraz: zegar, allegroDla: () => allegro, uuid: () => `uuid-${++i}` });
};

describe('Allegro One — kurier odbierający i osobne ustawienie', () => {
  it.each([['One Kurier', ONE_KURIER], ['One Box, One Kurier', ONE_BOX]])(
    '%s z transportem ALLEGRO_ONE_KURIER: zlecanie tylko przy włączonym podjazdy.allegro.one.aktywne', async (_n, metoda) => {
      const uslugi = { 'shipment-1': [metoda, ['ALLEGRO_ONE_KURIER']], 'shipment-2': [metoda, ['ALLEGRO_ONE_KURIER']] };
      const { db, ids } = dane(uslugi);
      const s = usluga(db, klient(uslugi));
      const wylaczone = await s.przygotuj({ ids, data: '2026-09-23', adres });
      expect(wylaczone.grupy).toHaveLength(1);
      expect(wylaczone.grupy[0].kurierOdbierajacy).toBe('ALLEGRO_ONE_KURIER');
      expect(wylaczone.grupy[0].moznaZlecac).toBe(false);
      // Włączony sam DPD nie odblokowuje One.
      ustaw(db, 'podjazdy.allegro.dpd.aktywne', '1');
      expect((await s.przygotuj({ ids, data: '2026-09-23', adres })).grupy[0].moznaZlecac).toBe(false);
      ustaw(db, 'podjazdy.allegro.one.aktywne', '1');
      expect((await s.przygotuj({ ids, data: '2026-09-23', adres })).grupy[0].moznaZlecac).toBe(true);
    });

  it('DPD nietknięte przy wyłączonym One, a włączony One nie odblokowuje DPD', async () => {
    const uslugi = { 'shipment-1': [DPD_WZA, ['DPD']] };
    const { db, ids } = dane(uslugi);
    const s = usluga(db, klient(uslugi));
    ustaw(db, 'podjazdy.allegro.one.aktywne', '1');
    const tylkoOne = await s.przygotuj({ ids, data: '2026-09-23', adres });
    expect(tylkoOne.grupy[0].kurierOdbierajacy).toBe('DPD');
    expect(tylkoOne.grupy[0].moznaZlecac).toBe(false);
    ustaw(db, 'podjazdy.allegro.one.aktywne', '0');
    ustaw(db, 'podjazdy.allegro.dpd.aktywne', '1');
    expect((await s.przygotuj({ ids, data: '2026-09-23', adres })).grupy[0].moznaZlecac).toBe(true);
  });

  it.each([
    ['One z transportem DPD', ONE_KURIER, ['DPD']],
    ['DPD z transportem ALLEGRO_ONE_KURIER', DPD_WZA, ['ALLEGRO_ONE_KURIER']],
    ['One Box z dwoma transportami', ONE_BOX, ['ALLEGRO_ONE_KURIER', 'DPD']],
    ['One Box, DPD (spoza mapy)', '0b257488-c85d-4507-b967-9b45ffbfa2e8', ['ALLEGRO_ONE_KURIER']],
  ])('%s: brak kuriera, bez zlecania', async (_n, metoda, transport) => {
    const uslugi = { 'shipment-1': [metoda, transport] };
    const { db, ids } = dane(uslugi);
    ustaw(db, 'podjazdy.allegro.one.aktywne', '1');
    ustaw(db, 'podjazdy.allegro.dpd.aktywne', '1');
    const podglad = await usluga(db, klient(uslugi)).przygotuj({ ids, data: '2026-09-23', adres });
    expect(podglad.grupy[0].kurierOdbierajacy).toBeNull();
    expect(podglad.grupy[0].moznaZlecac).toBe(false);
  });

  it('paczki One i DPD z jednego zaznaczenia → dwie grupy, każda ze swoim kurierem', async () => {
    const uslugi = { 'shipment-1': [ONE_KURIER, ['ALLEGRO_ONE_KURIER']], 'shipment-2': [DPD_WZA, ['DPD']],
      'shipment-3': [ONE_KURIER, ['ALLEGRO_ONE_KURIER']] };
    const { db, ids } = dane(uslugi);
    ustaw(db, 'podjazdy.allegro.one.aktywne', '1');
    const podglad = await usluga(db, klient(uslugi)).przygotuj({ ids, data: '2026-09-23', adres });
    expect(podglad.grupy.map((g) => [g.kurierOdbierajacy, g.przesylki.map((p) => p.shipmentId), g.moznaZlecac])).toEqual([
      ['ALLEGRO_ONE_KURIER', ['shipment-1', 'shipment-3'], true],
      ['DPD', ['shipment-2'], false],
    ]);
  });

  it('wyłączenie One po podglądzie wstrzymuje zlecenie (podgląd i POST)', async () => {
    const uslugi = { 'shipment-1': [ONE_KURIER, ['ALLEGRO_ONE_KURIER']] };
    const { db, ids } = dane(uslugi);
    const allegro = klient(uslugi);
    const s = usluga(db, allegro);
    ustaw(db, 'podjazdy.allegro.one.aktywne', '1');
    ustaw(db, 'podjazdy.allegro.dpd.aktywne', '1');
    const podglad = await s.przygotuj({ ids, data: '2026-09-23', adres });
    expect(podglad.grupy[0].moznaZlecac).toBe(true);
    ustaw(db, 'podjazdy.allegro.one.aktywne', '0');
    expect(s.pobierzPodglad({ id: podglad.id }).grupy[0].moznaZlecac).toBe(false);
    await expect(s.zlec({ podgladId: podglad.id, grupaId: podglad.grupy[0].id, termin })).rejects.toThrow(/wstrzymane/);
    expect(allegro.zlecPodjazd).not.toHaveBeenCalled();
  });
});

describe('puste pickupTimes — zlecenie z samą datą', () => {
  it('DPD z pustymi pickupTimes: bez oferty samej daty — diagnoza, zlecenie zablokowane (decyzja kierownika)', async () => {
    const dpd = { 'shipment-1': [DPD_WZA, ['DPD']] };
    const { db, ids } = dane(dpd);
    const allegro = klient(dpd, { terminy: () => [] });
    const s = usluga(db, allegro);
    ustaw(db, 'podjazdy.allegro.dpd.aktywne', '1');
    const g = (await s.przygotuj({ ids, data: '2026-09-23', adres })).grupy[0];
    expect(g.terminy).toEqual([]);
    expect(g.diagnoza.przyczyna).toBe('paczka-bez-terminu');
    await expect(s.zlec({ podgladId: 'x', grupaId: g.id, termin: { date: '2026-09-23' }, kto: 'test' })).rejects.toThrow();
    expect(allegro.zlecPodjazd).not.toHaveBeenCalled();
  });

  const uslugi = { 'shipment-1': [ONE_BOX, ['ALLEGRO_ONE_KURIER']], 'shipment-2': [ONE_BOX, ['ALLEGRO_ONE_KURIER']] };

  it('podgląd oferuje samą datę gotowości, bez diagnozy błędu; ciało zlecenia bez minTime/maxTime', async () => {
    const { db, ids } = dane(uslugi);
    const allegro = klient(uslugi, { terminy: () => [] });
    const s = usluga(db, allegro);
    ustaw(db, 'podjazdy.allegro.one.aktywne', '1');
    const podglad = await s.przygotuj({ ids, data: '2026-09-23', adres });
    const g = podglad.grupy[0];
    expect(g.terminy).toEqual([{ date: '2026-09-23' }]);
    expect(g.diagnoza).toBeNull();
    expect(g.moznaZlecac).toBe(true);
    await s.zlec({ podgladId: podglad.id, grupaId: g.id, termin: { date: '2026-09-23' }, kto: 'test' });
    expect(allegro.zlecPodjazd).toHaveBeenCalledTimes(1);
    const { input } = allegro.zlecPodjazd.mock.calls[0][0];
    expect(input.pickupTime).toStrictEqual({ date: '2026-09-23' });
    expect(Object.keys(input.pickupTime)).toEqual(['date']);
    expect(JSON.parse(JSON.stringify(input))).toEqual({ shipmentIds: ['shipment-1', 'shipment-2'],
      pickupTime: { date: '2026-09-23' }, address: adres });
    const log = db.prepare("SELECT wynik FROM log WHERE akcja='podjazd.zlecenie'").all().map((w) => w.wynik).join('\n');
    expect(log).toContain('termin 2026-09-23 — godzinę ustali przewoźnik');
    expect(log).not.toContain('undefined');
    expect(JSON.parse(db.prepare('SELECT termin_json FROM podjazdy').get().termin_json)).toEqual({ date: '2026-09-23' });
  });

  it('termin z godzinami nie pasuje do oferty samej daty (i odwrotnie)', async () => {
    const { db, ids } = dane(uslugi);
    const allegro = klient(uslugi, { terminy: () => [] });
    const s = usluga(db, allegro);
    ustaw(db, 'podjazdy.allegro.one.aktywne', '1');
    const podglad = await s.przygotuj({ ids, data: '2026-09-23', adres });
    await expect(s.zlec({ podgladId: podglad.id, grupaId: podglad.grupy[0].id, termin }))
      .rejects.toThrow(/nie pochodzi/);
    expect(allegro.zlecPodjazd).not.toHaveBeenCalled();
  });

  it('gdy przed zatwierdzeniem Allegro poda godziny, sama data już nie przechodzi', async () => {
    const { db, ids } = dane(uslugi);
    const allegro = klient(uslugi, { terminy: () => [] });
    const s = usluga(db, allegro);
    ustaw(db, 'podjazdy.allegro.one.aktywne', '1');
    const podglad = await s.przygotuj({ ids, data: '2026-09-23', adres });
    allegro.pobierzPropozycjePodjazdu.mockImplementationOnce(async ({ shipmentIds, address }) => [{
      address, proposals: shipmentIds.map((shipmentId) => ({ shipmentId, pickupTimes: [termin] })) }]);
    await expect(s.zlec({ podgladId: podglad.id, grupaId: podglad.grupy[0].id, termin: { date: '2026-09-23' } }))
      .rejects.toThrow(/zniknął/);
    expect(allegro.zlecPodjazd).not.toHaveBeenCalled();
  });

  it('domena: puste terminy wszystkich paczek → sama data; część paczek z terminami → nadal brak oferty', () => {
    const ids = ['s1', 's2'];
    const odp = (t1, t2) => [{ address: adres, proposals: [{ shipmentId: 's1', pickupTimes: t1 }, { shipmentId: 's2', pickupTimes: t2 }] }];
    expect(ofertyPodjazdu(odp([], undefined), ids, adres, '2026-09-23')).toEqual([{ date: '2026-09-23' }]);
    // Diagnoza powstaje tylko bez oferty (np. DPD — oferta samej daty jest wyłącznie dla One): puste terminy to brak terminu.
    expect(diagnozaTerminow(odp([], []), ids, adres).przyczyna).toBe('paczka-bez-terminu');
    expect(ofertyPodjazdu(odp([termin], []), ids, adres, '2026-09-23')).toEqual([]);
    expect(diagnozaTerminow(odp([termin], []), ids, adres).przyczyna).toBe('paczka-bez-terminu');
    // Bez daty gotowości albo z odpowiedzią spoza zestawu/adresu — nic.
    expect(ofertyPodjazdu(odp([], []), ids, adres)).toEqual([]);
    expect(ofertyPodjazdu(odp([], []), ['s1'], adres, '2026-09-23')).toEqual([]);
    expect(ofertyPodjazdu(odp([], []), ids, { ...adres, city: 'Kraków' }, '2026-09-23')).toEqual([]);
    expect(diagnozaTerminow(odp([], []), ids, { ...adres, city: 'Kraków' }).przyczyna).toBe('paczka-bez-terminu');
    expect(diagnozaTerminow([], ids, adres).przyczyna).toBe('pusta-odpowiedz');
  });

  it('domena: termin samej daty mija o północy; opis terminu bez „undefined”', () => {
    expect(podjazdPoTerminie({ date: '2026-09-23' }, '2026-09-23T21:00:00Z')).toBe(false);
    expect(podjazdPoTerminie({ date: '2026-09-23' }, '2026-09-23T22:30:00Z')).toBe(true);
    expect(opisTerminu({ date: '2026-09-23' })).toBe('2026-09-23 — godzinę ustali przewoźnik');
    expect(opisTerminu(termin)).toBe('2026-09-23, 10:00–14:00');
    expect(nazwaKuriera('ALLEGRO_ONE_KURIER')).toBe('Allegro One Kurier');
    expect(nazwaKuriera('DPD')).toBe('DPD');
  });
});

describe('ekran podglądu dla grupy One', () => {
  it('pokazuje „Allegro One Kurier” i pozwala wybrać samą datę', async () => {
    const db = openOmsDb();
    const podjazdy = { przygotuj: vi.fn(async () => ({ id: 'podglad-1', data: '2026-09-23', adres,
      wygasaAt: '2026-09-23T12:00:00Z', grupy: [
        { id: 'one', kanal: 'allegro_polcien', etykieta: 'Allegro One Box, One Kurier',
          kurierOdbierajacy: 'ALLEGRO_ONE_KURIER', moznaZlecac: true, przesylki: [{ numerListu: 'AO-1' }, { numerListu: 'AO-2' }],
          terminy: [{ date: '2026-09-23' }] },
        { id: 'one-wyl', kanal: 'allegro_polcien2', etykieta: 'Allegro One Kurier - dostawa jutro',
          kurierOdbierajacy: 'ALLEGRO_ONE_KURIER', moznaZlecac: false, przesylki: [{ numerListu: 'AO-3' }],
          terminy: [termin] },
      ] })) };
    const app = buildOmsServer({ db, config: { auth: { user: 'adam', pass: 'x' } }, podjazdy });
    const r = await app.inject({ method: 'POST', url: '/przesylki/podjazdy/podglad',
      headers: { ...auth, origin: 'http://localhost' }, payload: { ids: '1', data: '2026-09-23', ...adres } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Przesyłki odbierze: <strong>Allegro One Kurier</strong>');
    expect(r.body).toContain('Przesyłki odbierze <strong>Allegro One Kurier</strong>. Zlecanie podjazdów z OMS jest jeszcze wyłączone.');
    expect(r.body).not.toContain('ALLEGRO_ONE_KURIER');
    expect(r.body).toContain('value="{&#34;date&#34;:&#34;2026-09-23&#34;}">2026-09-23 — godzinę ustali przewoźnik</option>');
    expect(r.body).not.toContain('undefined');
    await app.close();
  });
});

describe('atrapa Allegro piaskownicy — podjazdy One', () => {
  function bazaDemo() {
    const db = openOmsDb();
    const dodaj = db.prepare(`INSERT INTO zamowienia (sklep,zrodlo_id,numer,utworzone_at,kwota_brutto,metoda_wysylki)
      VALUES ('allegro_polcien',?,?,'2026-09-22T08:00:00Z','0',?)`);
    dodaj.run('one-1', 'D1', 'allegro_punkt');
    dodaj.run('dpd-1', 'D2', 'allegro_dpd');
    const przesylka = db.prepare(`INSERT INTO przesylki (zamowienie_id,kurier,status,numer_listu,id_przesylki_kuriera,
      etykieta_sciezka,utworzona_at,kolejnosc) VALUES ((SELECT id FROM zamowienia WHERE numer=?),'allegro_wza','nadana',?,?,'e.pdf',
      '2026-09-22T08:00:00Z',?)`);
    przesylka.run('D1', 'ONE-1', 'demo-one-1', 1);
    przesylka.run('D1', 'ONE-2', 'demo-one-2', 2);
    przesylka.run('D2', 'DPD-1', 'demo-dpd-1', 1);
    return db;
  }
  const atrapa = (db) => createAtrapaAllegro({ db, kanal: 'allegro_polcien', env: ENV_DEMO, log: () => {} });

  it('zasób przesyłki One ma transport ALLEGRO_ONE_KURIER, a obce id daje 404', async () => {
    const a = atrapa(bazaDemo());
    await expect(a.pobierzPrzesylkeWza('demo-one-2')).resolves.toMatchObject({ id: 'demo-one-2', carrier: 'ALLEGRO',
      deliveryMethodId: ONE_BOX, transport: ['ALLEGRO_ONE_KURIER'], pickupAvailable: true, packages: [{ waybill: 'ONE-2' }] });
    await expect(a.pobierzPrzesylkeWza('demo-dpd-1')).resolves.toMatchObject({ deliveryMethodId: DPD_WZA, transport: ['DPD'] });
    await expect(a.pobierzPrzesylkeWza('nie-ma')).rejects.toMatchObject({ status: 404 });
  });

  it('propozycje: One Box bez godzin, DPD z godzinami; adres odesłany bez zmian', async () => {
    const a = atrapa(bazaDemo());
    const one = await a.pobierzPropozycjePodjazdu({ shipmentIds: ['demo-one-1', 'demo-one-2'], readyDate: '2026-09-23', address: adres });
    expect(ofertyPodjazdu(one, ['demo-one-1', 'demo-one-2'], adres, '2026-09-23')).toEqual([{ date: '2026-09-23' }]);
    const dpd = await a.pobierzPropozycjePodjazdu({ shipmentIds: ['demo-dpd-1'], readyDate: '2026-09-23', address: adres });
    const terminyDpd = ofertyPodjazdu(dpd, ['demo-dpd-1'], adres, '2026-09-23');
    expect(terminyDpd.length).toBeGreaterThan(0);
    expect(terminyDpd.every((t) => t.date === '2026-09-23' && t.minTime && t.maxTime)).toBe(true);
  });

  it('pełny obieg z usługą: zlecenie, stan SUCCESS i szczegóły potwierdzają podjazd One', async () => {
    const db = bazaDemo();
    ustaw(db, 'podjazdy.allegro.one.aktywne', '1');
    const a = atrapa(db);
    const s = createPodjazdy({ db, teraz: zegar, allegroDla: () => a });
    const ids = db.prepare("SELECT id FROM przesylki WHERE numer_listu LIKE 'ONE-%' ORDER BY id").all().map((w) => w.id);
    const podglad = await s.przygotuj({ ids, data: '2026-09-23', adres });
    expect(podglad.grupy[0]).toMatchObject({ kurierOdbierajacy: 'ALLEGRO_ONE_KURIER', moznaZlecac: true, terminy: [{ date: '2026-09-23' }] });
    const zlecony = await s.zlec({ podgladId: podglad.id, grupaId: podglad.grupy[0].id, termin: { date: '2026-09-23' } });
    expect(zlecony.stan).toBe('oczekuje');
    const sprawdzony = await s.sprawdz({ id: zlecony.id });
    expect(sprawdzony).toMatchObject({ stan: 'potwierdzony', pickup_carrier: 'ALLEGRO_ONE_KURIER' });
    expect(sprawdzony.pickup_id).toBeTruthy();
  });
});

describe('demo — paczki One gotowe do podjazdu', () => {
  it('dwie paczki WzA One w jednym zamówieniu, ustawienie One włączone, DPD nie; atrapa widzi transport One', async () => {
    const { utworzBazeDemo } = await import('../../../scripts/demo-dane.mjs');
    const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
    const { createRequire } = await import('node:module');
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const katalog = fs.mkdtempSync(path.join(os.tmpdir(), 'oms-demo-p402-'));
    try {
      await utworzBazeDemo({ baza: path.join(katalog, 'oms.sqlite'), dzis: '2026-10-15' });
      const db = new DatabaseSync(path.join(katalog, 'oms.sqlite'));
      const one = db.prepare(`SELECT p.*, z.sklep, z.metoda_wysylki_nazwa FROM przesylki p JOIN zamowienia z ON z.id = p.zamowienie_id
        WHERE p.kurier = 'allegro_wza' ORDER BY p.kolejnosc`).all();
      expect(one).toHaveLength(2);
      expect(new Set(one.map((p) => p.zamowienie_id)).size).toBe(1);
      expect(one.every((p) => p.status === 'nadana' && p.etykieta_sciezka && p.id_przesylki_kuriera && p.numer_listu)).toBe(true);
      expect(one[0].metoda_wysylki_nazwa).toBe('Allegro One Box, One Kurier');
      const ustawienie = (k) => db.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?').get(k)?.wartosc;
      expect(ustawienie('podjazdy.allegro.one.aktywne')).toBe('1');
      expect(ustawienie('podjazdy.allegro.dpd.aktywne')).toBeUndefined();
      const a = createAtrapaAllegro({ db, kanal: one[0].sklep, env: ENV_DEMO, log: () => {} });
      const zasob = await a.pobierzPrzesylkeWza(one[0].id_przesylki_kuriera);
      expect(zasob).toMatchObject({ deliveryMethodId: ONE_BOX, transport: ['ALLEGRO_ONE_KURIER'], pickupAvailable: true });
      db.close();
    } finally { fs.rmSync(katalog, { recursive: true, force: true }); }
  }, 120000);
});
