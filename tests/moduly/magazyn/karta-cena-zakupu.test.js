import { afterEach, beforeEach, expect, it } from 'vitest';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { historiaCenZakupu, zapiszCeneZakupu } from '../../../src/oms/db/ceny-zakupu.js';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { kartaPoId, utworzKarte } from '../../../src/oms/db/magazyn.js';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';

const od = '2020-11-05';
const przyszlaData = '2099-01-01';
const nazwa = 'Lampa Kopuła';
const origin = 'http://localhost';
let db, app, id, url, headers;

async function zaloguj(login, rola) {
  zalozKonto(db, { login, imie: 'Ada', haslo: 'test', rola, admin: false });
  const r = await app.inject({
    method: 'POST',
    url: '/login',
    headers: { origin },
    payload: { uzytkownik: login, haslo: 'test' },
  });
  expect(r.statusCode).toBe(302);
  return {
    origin,
    cookie: []
      .concat(r.headers['set-cookie'])
      .map((c) => c.split(';')[0])
      .join('; '),
  };
}

const get = (sufiks = '', h = headers) => app.inject({ url: url + sufiks, headers: h });
const post = (payload, h = headers) => app.inject({ method: 'POST', url, headers: h, payload });
const wpisz = (gr = 1230, data = od, kartaId = id) =>
  zapiszCeneZakupu(db, kartaId, { gr, od: data }, { zrodlo: 'hurt' });
const usun = (wpisId, h = headers) =>
  app.inject({ method: 'POST', url: `${url}/cena-zakupu/${wpisId}/usun`, headers: h });
const historia = () => historiaCenZakupu(db, id);

beforeEach(async () => {
  db = openOmsDb(':memory:');
  id = utworzKarte(db, { nazwa, stawka_vat: '23' });
  url = `/magazyn/${id}`;
  app = buildOmsServer({
    db,
    config: { auth: { user: 'operator', pass: 'test' } },
    magazyn: { stan: () => ({ trwa: false }) },
  });
  headers = await zaloguj('sprzedawca', 'sprzedaz');
});

afterEach(async () => {
  await app.close();
  db.close();
});

it('sprzedawca zapisuje grosze, datę, login i źródło bez zmiany znacznika karty', async () => {
  const przed = kartaPoId(db, id).zmieniony_at;
  const r = await post({ cena_zakupu_netto: '12,30', cena_zakupu_od: od });
  expect(r.statusCode).toBe(303);
  expect(historia()).toMatchObject([{ cena_netto_gr: 1230, obowiazuje_od: od, kto: 'sprzedawca', zrodlo: 'karta' }]);
  expect(kartaPoId(db, id).zmieniony_at).toBe(przed);
});

it('pokazuje cenę i pola bezpośrednio po stawce VAT w danych karty', async () => {
  wpisz();
  const podglad = await get();
  expect(podglad.statusCode).toBe(200);
  expect(podglad.body).toMatch(
    /<dt>Stawka VAT<\/dt>\s*<dd>[^]*?<\/dd>\s*<dt>Cena zakupu netto<\/dt>\s*<dd>\s*12,30 zł \(od 05\.11\.2020\)\s*<\/dd>\s*<dt>Kategoria główna<\/dt>/,
  );
  const edycja = await get('?edytuj=dane');
  expect(edycja.body).toMatch(
    /name="stawka_vat"[^]*?<\/label>\s*<label[^>]*>[^]*?name="cena_zakupu_netto"[^>]*value=""[^]*?type="date" name="cena_zakupu_od"[^]*?name="kategoria_glowna"/,
  );
});

it('pokazuje najbliższą przyszłą cenę oddzielnie od bieżącej i historię od najnowszej', async () => {
  wpisz();
  wpisz(1350, przyszlaData);
  wpisz(1550, '2099-02-01');
  const r = await get();
  expect(r.body).toContain('12,30 zł (od 05.11.2020)');
  expect(r.body).toContain('od 01.01.2099: 13,50 zł');
  expect(r.body).toMatch(/<details[^>]*>\s*<summary>Historia ceny zakupu \(3\)<\/summary>/);
  expect(r.body.indexOf('15,50 zł')).toBeLessThan(r.body.lastIndexOf('12,30 zł'));
});

it('pusta cena zachowuje historię przy zmianie innych danych', async () => {
  wpisz();
  const przed = historia();
  expect((await post({ nazwa: 'Lampa Stożek', cena_zakupu_netto: '', cena_zakupu_od: przyszlaData })).statusCode).toBe(
    303,
  );
  expect(kartaPoId(db, id).nazwa).toBe('Lampa Stożek');
  expect(historia()).toEqual(przed);
});

it.each([
  ['12,345', od, 'najwyżej 2 miejsca po przecinku'],
  ['12345678901234567890', od, 'kwota większa niż'],
  ['12,30', '2026-02-30', 'podaj prawdziwą datę'],
])('błędny wpis (%s, %s) zatrzymuje cały zapis i wraca do formularza', async (kwota, data, komunikat) => {
  const r = await post({ nazwa: 'Lampa Stożek', cena_zakupu_netto: kwota, cena_zakupu_od: data });
  expect(r.statusCode).toBe(400);
  expect(r.body).toContain(komunikat);
  expect(r.body).toMatch(new RegExp(`name="cena_zakupu_netto"[^>]*value="${kwota}"`));
  expect(r.body).toContain(`name="cena_zakupu_od" value="${data}"`);
  expect(kartaPoId(db, id).nazwa).toBe(nazwa);
  expect(historia()).toEqual([]);
});

it('wycofuje zmianę karty, gdy baza odrzuca zapis ceny', async () => {
  db.exec(`CREATE TRIGGER odmowa_ceny BEFORE INSERT ON ceny_zakupu_kart
    BEGIN SELECT RAISE(ABORT, 'odmowa zapisu'); END`);
  expect((await post({ nazwa: 'Lampa Stożek', cena_zakupu_netto: '12,30', cena_zakupu_od: od })).statusCode).toBe(500);
  expect(kartaPoId(db, id).nazwa).toBe(nazwa);
  expect(historia()).toEqual([]);
});

it('pomija powtórzenie obowiązującej kwoty i zastępuje inną kwotę z tej samej daty', async () => {
  const wpisId = wpisz();
  expect((await post({ cena_zakupu_netto: '12.30', cena_zakupu_od: przyszlaData })).statusCode).toBe(303);
  expect(historia()).toMatchObject([{ id: wpisId, cena_netto_gr: 1230, zrodlo: 'hurt' }]);
  expect((await post({ cena_zakupu_netto: '0', cena_zakupu_od: od })).statusCode).toBe(303);
  expect(historia()).toMatchObject([{ id: wpisId, cena_netto_gr: 0, zrodlo: 'karta' }]);
});

it('sprzedawca potwierdza i usuwa tylko wpis należący do otwartej karty', async () => {
  const wpisId = wpisz();
  const innaKarta = utworzKarte(db, { nazwa: 'Lampa Stożek' });
  const innyWpis = wpisz(1250, od, innaKarta);
  const potwierdzenie = await get(`?usun-cene=${wpisId}`);
  expect(potwierdzenie.statusCode).toBe(200);
  expect(potwierdzenie.body).toContain('Usunąć cenę 12,30 zł od 05.11.2020?');
  expect(historia()).toHaveLength(1);
  expect((await usun(innyWpis)).statusCode).toBe(404);
  expect((await usun('9007199254740993')).statusCode).toBe(404);
  const r = await usun(wpisId);
  expect(r.statusCode).toBe(303);
  expect(r.headers.location).toBe(`${url}#dane-karty`);
  expect(historia()).toEqual([]);
  expect(historiaCenZakupu(db, innaKarta)).toHaveLength(1);
});

it('konto bez magazynu otrzymuje 403 przy odczycie, zapisie i usunięciu ceny', async () => {
  const wpisId = wpisz();
  const przed = historia();
  const pakowacz = await zaloguj('pakowacz', 'produkcja');
  const odczyt = await get(`?usun-cene=${wpisId}`, pakowacz);
  expect(odczyt.statusCode).toBe(403);
  expect(odczyt.body).not.toContain('12,30');
  expect((await post({ cena_zakupu_netto: '15,00', cena_zakupu_od: od }, pakowacz)).statusCode).toBe(403);
  expect((await usun(wpisId, pakowacz)).statusCode).toBe(403);
  expect(historia()).toEqual(przed);
});

it('potwierdzenie jest w treści strony i działa bez confirm()', async () => {
  const wpisId = wpisz();
  const r = await get(`?usun-cene=${wpisId}`);
  expect(r.body).toContain(`action="${url}/cena-zakupu/${wpisId}/usun"`);
  expect(r.body).not.toMatch(/confirm\s*\(/);
});

it('historia ceny zakupu nazywa źródło po polsku: „karta” albo „edycja hurtem”', async () => {
  wpisz(1230, od);
  zapiszCeneZakupu(db, id, { gr: 1350, od: przyszlaData }, { zrodlo: 'karta', kto: 'sprzedawca' });
  const r = await get();
  const komorki = [...r.body.matchAll(/<td>(karta|edycja hurtem|hurt)<\/td>/g)].map((m) => m[1]);
  expect(komorki.sort()).toEqual(['edycja hurtem', 'karta']);
});

it('dopiski w etykietach ceny zakupu czytnik dostaje raz — jako opis pola, nie w nazwie', async () => {
  const r = await get('?edytuj=dane');
  const dopisek = /<small id="cena-zakupu-podpowiedz"([^>]*)>/.exec(r.body);
  expect(dopisek).not.toBeNull();
  expect(dopisek[1]).toContain('aria-hidden="true"');
  const zla = await post({ cena_zakupu_netto: '12,30', cena_zakupu_od: '2020-02-30' });
  const wpisana = /<small id="cena-zakupu-wpisana-data"([^>]*)>/.exec(zla.body);
  expect(wpisana).not.toBeNull();
  expect(wpisana[1]).toContain('aria-hidden="true"');
});
