import { beforeEach, afterEach, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { dodajZwrot } from '../../../src/oms/db/zwroty.js';
import { kwotaOczekiwanaGrosze } from '../../../src/domena/suma-pozycji.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

const headers = { authorization: 'Basic ' + Buffer.from('operator:x').toString('base64'), origin: 'http://localhost' };
const linia = (zrodlo_id, nazwa = 'Pracownia Półcień') => ({ zrodlo_id, nazwa, sku: 'DEMO', ilosc: 1,
  cena_brutto: '123.00', brutto_linii: '123.00', cena_netto: '100.00', netto_linii: '100.00', vat: null });
const dane = (nad = {}) => ({ zrodlo_id: 1, numer: 'DEMO-1', klient: { email: 'demo@example.test' }, dostawa: {},
  kwota_brutto: '246.00', koszt_dostawy_brutto: '0.00', koszt_dostawy_netto: '0.00',
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, oplacone_at: null,
  anulowane: 0, utworzone_at: '2026-11-05T00:00:00',
  status_woo: 'processing', pozycje: [linia('1'), linia('2', 'Druga pozycja')], ...nad });
let db, app;
beforeEach(async () => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config: { auth: { user: 'operator', pass: 'x' }, sklepy: {} },
    poller: { stan: () => ({}) } });
  await app.ready();
});
afterEach(async () => { await app.close(); db.close(); });
const post = (id, body, droga = 'zapisz', naglowki = headers) => app.inject({ method: 'POST',
  url: `/zamowienia/${id}/pozycje/${droga}`, headers: naglowki, payload: body });
const nowy = (nad = {}) => ({ klucz: '', nazwa: 'Nowa pozycja', sku: 'DEMO-N', ilosc: '2', cena_netto: '10.00',
  cena_brutto: '', vat: '23', ...nad });
const tabela = (wiersze, przycisk = {}) => Object.assign(Object.fromEntries(
  ['klucz', 'nazwa', 'sku', 'ilosc', 'cena_netto', 'cena_brutto', 'vat'].map((k) => [k, wiersze.map((w) => w[k] ?? '')])), przycisk);
const edycja = (id) => `/zamowienia/${id}?edytuj=pozycje#pozycje`;

for (const [kanal, klucz] of [['woo', 's1'], ['allegro', 's1'], ['allegro', 'sdoplata']]) {
  it(`${kanal} ${klucz}: ×, poller, przywróć i NULL mapy`, async () => {
    const zam = dane({ pozycje: [linia('1'), linia(klucz === 'sdoplata' ? 'doplata' : '2', 'Druga pozycja')] });
    const id = zapiszZamowienie(db, kanal, zam, {});
    const przed = kwotaOczekiwanaGrosze(pobierzZamowienie(db, id));
    const r = await post(id, tabela([nowy({ nazwa: '', sku: '', cena_netto: '' })], { usun: klucz }));
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe(edycja(id));
    let z = pobierzZamowienie(db, id);
    expect(z.pozycje.some((p) => p.klucz === klucz)).toBe(false);
    expect(z.pozycje_usuniete.map((p) => p.klucz)).toEqual([klucz]);
    expect(kwotaOczekiwanaGrosze(z)).toBe(przed - 12300);
    zapiszZamowienie(db, kanal, { ...zam, pozycje: zam.pozycje.map((p) => ({ ...p, ilosc: 2 })) }, {});
    z = pobierzZamowienie(db, id);
    expect(z.pozycje.some((p) => p.klucz === klucz)).toBe(false);
    const przywroc = await post(id, {}, `${klucz}/przywroc`);
    expect(przywroc.statusCode).toBe(303);
    expect(przywroc.headers.location).toBe(edycja(id));
    z = pobierzZamowienie(db, id);
    expect(z.pozycje.find((p) => p.klucz === klucz).ilosc).toBe(2);
    expect(z.pozycje_reczne_json).toBeNull();
    expect(db.prepare('SELECT akcja FROM log WHERE zamowienie_id = ?').all(id).map((x) => x.akcja))
      .toEqual(expect.arrayContaining(['pozycja.usunieta', 'pozycja.przywrocona']));
  });
}

for (const droga of ['zapisz', 's1/usun']) {
  for (const blokada of ['faktura', 'zwrot']) {
    it(`${droga}: ${blokada} odmawia usunięcia i nie zmienia bazy`, async () => {
      const id = zapiszZamowienie(db, 'woo', dane(), {});
      if (blokada === 'faktura') db.prepare("INSERT INTO faktury (zamowienie_id, ksef_status, utworzona_at) VALUES (?, 'w_toku', ?)").run(id, '2026-11-05');
      else dodajZwrot(db, id, { data: '2026-11-05', kwota: '1.00', pozycje: [{ klucz_pozycji: 's1', nazwa: 'Demo', ilosc: 1, kwota: '1.00' }] });
      const przed = pobierzZamowienie(db, id);
      const r = await post(id, tabela([nowy()], { usun: 's1' }), droga);
      expect(r.statusCode).toBe(400);
      expect(r.body).toMatch(blokada === 'faktura' ? /korekta/ : /zarejestrowany zwrot/);
      expect(pobierzZamowienie(db, id)).toEqual(przed);
      expect(db.isTransaction).toBe(false);
    });
  }
}

it('nowy wiersz z netto oraz dodaj_wiersz bez JS', async () => {
  const id = zapiszZamowienie(db, 'woo', dane(), {});
  const r = await post(id, tabela([nowy()], { dodaj_wiersz: '1' }));
  expect(r.statusCode).toBe(303);
  expect(r.headers.location).toBe(edycja(id));
  expect(pobierzZamowienie(db, id).pozycje.find((p) => p.reczna)).toMatchObject({ cena_brutto: '12.30', brutto_linii: '24.60', sku: 'DEMO-N' });
});

it('WDT: nowy wiersz z netto liczy 0%, zachowuje stawkę domyślną', async () => {
  const id = zapiszZamowienie(db, 'woo', dane({ nip: 'DE123456789' }), {});
  const r = await post(id, tabela([nowy({ vat: '' })]));
  expect(r.statusCode).toBe(302);
  expect(pobierzZamowienie(db, id).pozycje.find((p) => p.reczna)).toMatchObject({ cena_brutto: '10.00', vat: '23' });
  expect(r.headers.location).toBe(`/zamowienia/${id}#pozycje`);
});

it('B5: zw bez programu odmawia', async () => {
  const id = zapiszZamowienie(db, 'woo', dane(), {});
  const r = await post(id, tabela([nowy({ vat: 'zw' })]));
  expect(r.statusCode).toBe(400);
  expect(pobierzZamowienie(db, id).pozycje).toHaveLength(2);
});

it('usun_nowy pomija wskazany wiersz i wraca do edycji', async () => {
  const id = zapiszZamowienie(db, 'woo', dane(), {});
  const r = await post(id, tabela([nowy({ nazwa: '' }), nowy()], { usun_nowy: '0' }));
  expect(r.statusCode).toBe(303);
  expect(r.headers.location).toBe(edycja(id));
  expect(pobierzZamowienie(db, id).pozycje.filter((p) => p.reczna)).toHaveLength(1);
});

it('B10: obca Origin odrzucona bez zapisu', async () => {
  const id = zapiszZamowienie(db, 'woo', dane(), {});
  const r = await post(id, tabela([nowy()], { usun: 's1' }), 'zapisz', { ...headers, origin: 'https://obca.example.test' });
  expect(r.statusCode).toBe(403);
  expect(pobierzZamowienie(db, id).pozycje).toHaveLength(2);
});

it('błąd parsowania trzeciego wiersza nie zapisuje pierwszych dwóch', async () => {
  const id = zapiszZamowienie(db, 'woo', dane(), {});
  const przed = pobierzZamowienie(db, id);
  const r = await post(id, tabela([nowy(), nowy(), nowy({ ilosc: '0' })]));
  expect(r.statusCode).toBe(400);
  expect(pobierzZamowienie(db, id)).toEqual(przed);
});

it('awaria bazy przy trzecim zapisie wycofuje całą transakcję', async () => {
  const id = zapiszZamowienie(db, 'woo', dane(), {});
  db.exec("CREATE TRIGGER odmowa_demo BEFORE INSERT ON pozycje WHEN NEW.nazwa = 'Awaria' BEGIN SELECT RAISE(ABORT, 'awaria demo'); END");
  const przed = pobierzZamowienie(db, id);
  const r = await post(id, tabela([nowy(), nowy(), nowy({ nazwa: 'Awaria' })]));
  expect(r.statusCode).toBe(400);
  expect(pobierzZamowienie(db, id)).toEqual(przed);
});

const komunikatZmiany = 'Nie można zmienić pozycji po rozpoczęciu wystawiania faktury — zmianę kwoty obsługuje korekta.';
for (const reczna of [false, true]) {
  for (const zmiana of [{ cena_brutto: '124.00' }, { cena_netto: '101.00' }, { ilosc: '2' }, { nazwa: 'Poprawiona nazwa' }]) {
    for (const faktura of [false, true]) {
      it(`zapisz: ręczna=${reczna}, faktura=${faktura}, ${JSON.stringify(zmiana)}`, async () => {
        const id = zapiszZamowienie(db, 'woo', dane(), {});
        if (reczna) expect((await post(id, tabela([nowy({ ilosc: '1', cena_netto: '100.00' })]))).statusCode).toBe(302);
        if (faktura) db.prepare('INSERT INTO faktury (zamowienie_id, ksef_status, utworzona_at) VALUES (?, ?, ?)').run(id, 'w_toku', new Date().toISOString());
        const przed = pobierzZamowienie(db, id);
        const p = przed.pozycje.find((p) => Boolean(p.reczna) === reczna);
        const r = await post(id, tabela([nowy(), { ...p, cena_netto: '100.00', ...zmiana }]));
        const odmowa = faktura && !zmiana.nazwa;
        expect(r.statusCode).toBe(odmowa ? 400 : 302);
        if (odmowa) {
          expect(r.body).toContain(komunikatZmiany);
          expect(r.body).toContain('<form');
          expect(r.body).toContain('id="pozycje"');
          expect(pobierzZamowienie(db, id)).toEqual(przed);
          expect(db.isTransaction).toBe(false);
        } else {
          const po = pobierzZamowienie(db, id).pozycje.find((w) => w.klucz === p.klucz);
          expect(po).toMatchObject(zmiana.nazwa ? { nazwa: zmiana.nazwa } : zmiana.ilosc ? { ilosc: 2 }
            : { cena_brutto: zmiana.cena_netto ? '124.23' : '124.00' });
        }
      });
    }
  }
}

for (const poprawka of [{ usunieta: true }, { cena_brutto: '100.00' }, { ilosc: 2 }, { nazwa: 'Poprawiona nazwa' }]) {
  for (const ksef_status of [null, 'w_toku', 'do_wyjasnienia']) {
    it(`przywróć ${JSON.stringify(poprawka)}, stan=${ksef_status}: odmowa kwoty, nazwa dozwolona`, async () => {
      const id = zapiszZamowienie(db, 'woo', dane(), {});
      db.prepare('UPDATE zamowienia SET pozycje_reczne_json = ? WHERE id = ?').run(JSON.stringify({ s1: poprawka }), id);
      db.prepare('INSERT INTO faktury (zamowienie_id, ksef_status, utworzona_at) VALUES (?, ?, ?)').run(id, ksef_status, new Date().toISOString());
      const przed = pobierzZamowienie(db, id);
      const r = await post(id, {}, 's1/przywroc');
      expect(r.statusCode).toBe(poprawka.nazwa ? 302 : 400);
      if (!poprawka.nazwa) {
        expect(r.body).toContain(komunikatZmiany);
        expect(r.body).toContain('<form');
        expect(pobierzZamowienie(db, id)).toEqual(przed);
        expect(db.isTransaction).toBe(false);
        expect(db.prepare("SELECT * FROM log WHERE zamowienie_id = ? AND akcja = 'pozycja.przywrocona'").all(id)).toEqual([]);
      }
    });
  }
}

// Poprawka ceny sklepowej: porównanie po fakturze idzie z ceną po poprawce (p), nie ze sklepową (p.sklep).
it('po fakturze: pozycja z poprawką ceny — powrót do ceny sklepu odmawia, sama nazwa przechodzi', async () => {
  const id = zapiszZamowienie(db, 'woo', dane(), {});
  db.prepare('UPDATE zamowienia SET pozycje_reczne_json = ? WHERE id = ?').run(JSON.stringify({ s1: { cena_brutto: '100.00' } }), id);
  db.prepare('INSERT INTO faktury (zamowienie_id, ksef_status, utworzona_at) VALUES (?, ?, ?)').run(id, 'w_toku', new Date().toISOString());
  const przed = pobierzZamowienie(db, id);
  const p = przed.pozycje.find((x) => x.klucz === 's1');
  expect(p.cena_brutto).toBe('100.00');
  const wiersz = (nad) => ({ ...p, cena_netto: '', cena_brutto: '100.00', ...nad });
  const odmowa = await post(id, tabela([nowy(), wiersz({ cena_brutto: '123.00' })]));
  expect(odmowa.statusCode).toBe(400);
  expect(odmowa.body).toContain(komunikatZmiany);
  expect(pobierzZamowienie(db, id)).toEqual(przed);
  const ok = await post(id, tabela([nowy(), wiersz({ nazwa: 'Poprawiona nazwa' })]));
  expect(ok.statusCode).toBe(302);
  expect(pobierzZamowienie(db, id).pozycje.find((x) => x.klucz === 's1')).toMatchObject({ nazwa: 'Poprawiona nazwa', cena_brutto: '100.00' });
});
