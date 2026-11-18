import { it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zbudujAplikacje } from '../../../src/core/aplikacja.ts';
import { modulyPiaskownicy } from '../../../deploy/proba/atrapy/index.mjs';
import { utworzBazeDemo, ENV_DEMO } from '../../../scripts/demo-dane.mjs';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { podpisz } from '../../../src/core/bezpieczenstwo/sesja.js';
import { wczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import { ustawRejestrKanalow, MODULY_KANALOW } from '../../../src/domena/moduly-kanalow.ts';

let db, app, katalog;
afterEach(async () => {
  await app?.app.close();
  db?.close();
  if (katalog) fs.rmSync(katalog, { recursive: true, force: true });
});
async function setup() {
  katalog = fs.mkdtempSync(path.join(tmpdir(), 'erli-granice-prz160p1-'));
  const env = {
    ...ENV_DEMO,
    OMS_USER: 'serwis',
    OMS_PASS: 'fixture-testowe',
    OMS_DB_PATH: path.join(katalog, 'oms.sqlite'),
    OMS_PROFORMY_KATALOG: path.join(katalog, 'proformy'),
    OMS_ETYKIETY_KATALOG: path.join(katalog, 'etykiety'),
  };
  const dzis = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
  await utworzBazeDemo({ baza: env.OMS_DB_PATH, dzis, env });
  db = openOmsDb(env.OMS_DB_PATH);
  zalozKonto(db, {
    login: 'admin',
    imie: 'Administrator',
    haslo: 'fixture-testowe',
    rola: 'administrator',
    admin: true,
  });
  const start = async () => {
    app = await zbudujAplikacje({ db, env, moduly: modulyPiaskownicy(env, { baza: () => db }), log: () => {} });
  };
  await start();
  const cookie = 'sesja_oms_proba=' + podpisz('admin', wczytajSekret(db), Date.now());
  const raport = () => app.app.inject({ method: 'GET', url: '/raporty', headers: { cookie } });
  const poll = async () => {
    ustawRejestrKanalow((k) => (k === 'erli_polcien' ? 'erli' : null), MODULY_KANALOW);
    await app.usluga('kanaly', 'rejestrKanalow').przebiegZamowien();
  };
  return { start, raport, poll };
}
const granica = () => db.prepare("SELECT * FROM granice_historii WHERE kanal='ERLI_POLCIEN'").get();
const dzienPrzed = (utc) => {
  const d = new Date(utc).toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
  return new Date(Date.parse(d + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
};
it('demo po pobraniu ERLI pokazuje sprzedaż brutto', async () => {
  const f = await setup();
  await f.poll();
  expect(db.prepare("SELECT count(*) n FROM zamowienia WHERE sklep='erli_polcien'").get().n).toBe(30);
  const r = await f.raport();
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain('Sprzedaż brutto');
  expect(r.body).not.toContain('Nie da się');
}, 200000);
it('restart naprawia brak granicy po pobraniu, bez resetu zamówień', async () => {
  const f = await setup();
  await f.poll();
  await app.app.close();
  db.prepare("DELETE FROM granice_historii WHERE kanal='ERLI_POLCIEN'").run();
  const przed = db.prepare("SELECT * FROM zamowienia WHERE sklep='erli_polcien'").all();
  await f.start();
  expect(granica()?.do_dnia).toBe(
    dzienPrzed(db.prepare("SELECT od_utc FROM kanaly_sprzedazy WHERE klucz='erli_polcien'").get().od_utc),
  );
  expect(db.prepare("SELECT * FROM zamowienia WHERE sklep='erli_polcien'").all()).toEqual(przed);
  expect((await f.raport()).statusCode).toBe(200);
}, 200000);
it.each([false, true])(
  'aktywacja ERLI i transakcyjna odmowa dla starego zamówienia: %s',
  async (stare) => {
    await setup();
    const usluga = app.usluga('kanaly', 'sklepyErli');
    const aktor = { id: 0, login: 'test' };
    const nowy = await usluga.operacja(
      'nowe',
      'dane',
      {
        wersja: 0,
        nazwa: 'Pracownia Półcień',
        adresApi: 'https://sandbox.erli.dev/svc/shop-api',
        kluczApi: 'atrapa-polcien',
      },
      aktor,
    );
    expect(nowy.ok).toBe(true);
    const k = nowy.klucz;
    expect((await usluga.operacja(k, 'sprawdz', { wersja: 1 }, aktor)).ok).toBe(true);
    const kanal = db.prepare('SELECT * FROM kanaly_sprzedazy WHERE klucz=?').get(k);
    const granicaNowego = () => db.prepare('SELECT * FROM granice_historii WHERE kanal=?').get(kanal.raport);
    if (stare) {
      // Istniejący fikcyjny rekord demo przeniesiony przed planowaną granicę ERLI.
      db.prepare(
        "UPDATE zamowienia SET sklep=?,utworzone_at='2020-01-01T12:00:00Z' WHERE id=(SELECT id FROM zamowienia LIMIT 1)",
      ).run(k);
    }
    const od = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
    const wywolaj = () => usluga.operacja(k, 'aktywuj', { wersja: kanal.wersja, od }, aktor);
    if (stare) {
      const przed = db.prepare('SELECT * FROM konfiguracja_integracji').all();
      await expect(wywolaj()).rejects.toThrow('Granica nie może wyciąć');
      expect(db.prepare('SELECT * FROM kanaly_sprzedazy WHERE klucz=?').get(k)).toEqual(kanal);
      expect(db.prepare('SELECT * FROM konfiguracja_integracji').all()).toEqual(przed);
      expect(granicaNowego()).toBeUndefined();
    } else {
      expect((await wywolaj()).ok).toBe(true);
      const aktywny = db.prepare('SELECT * FROM kanaly_sprzedazy WHERE klucz=?').get(k);
      expect(aktywny.autoryzacja).toBe('polaczone');
      expect(aktywny.od_utc.slice(0, 10)).not.toBe(od);
      expect(granicaNowego()?.do_dnia).toBe(dzienPrzed(aktywny.od_utc));
      expect(granicaNowego()?.uwaga).toBe('Aktywacja nowego kanału');
    }
  },
  200000,
);
it('restart odmawia granicy wycinającej istniejące zamówienie', async () => {
  const f = await setup();
  await f.poll();
  await app.app.close();
  db.prepare("DELETE FROM granice_historii WHERE kanal='ERLI_POLCIEN'").run();
  db.prepare("UPDATE zamowienia SET utworzone_at='2020-01-01T12:00:00Z' WHERE sklep='erli_polcien'").run();
  const przed = db.prepare("SELECT * FROM zamowienia WHERE sklep='erli_polcien'").all();
  await f.start();
  expect(granica()).toBeUndefined();
  expect(db.prepare("SELECT * FROM zamowienia WHERE sklep='erli_polcien'").all()).toEqual(przed);
}, 200000);
