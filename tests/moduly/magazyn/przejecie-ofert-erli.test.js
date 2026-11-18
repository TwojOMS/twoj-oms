import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import {
  ofertyKarty,
  wstawOferte,
  ofertaPoId,
  zapiszUstawieniaOfertKonta,
} from '../../../src/oms/db/oferty-kanalow.ts';
import { zalozKonto, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { podpisz, NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';
import { wczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import {
  LIMIT_STRONY_PRZEJECIA,
  MAKS_STRON_PRZEJECIA,
} from '../../../src/moduly/magazyn/services/przejecie-ofert-erli.js';
import { createPetlaOfert } from '../../../src/moduly/magazyn/services/petla-ofert.js';
import { katalogErli } from '../../../src/integracje/kanal-modul.ts';
const kanal = 'erli-polcien';
const auth = {
  authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}`,
  origin: 'http://localhost',
};
let db, app, id, klient;
const post = (url, payload = {}, headers = auth) => app.inject({ method: 'POST', url, payload, headers });
const pobierz = () => post('/magazyn/powiazania/erli/pobierz', { konto: kanal });
const token = (r) => /name="podglad" value="([^"]+)"/.exec(r.body)?.[1];
const przejmij = (zaznaczone = ['reczna/01']) =>
  post('/magazyn/powiazania/erli/zatwierdz', { konto: kanal, zaznaczone });
const objecie = (o) => `/magazyn/${id}/oferty/${o.id}/objecie`;
const karta = (sku, ean = null, nazwa = 'Lampa Półcień') =>
  utworzKarte(db, { nazwa, sku, ean, cena_gr: 10000, stawka_vat: '23' });
beforeEach(async () => {
  db = openOmsDb(':memory:');
  klient = {
    szukajProduktow: vi.fn(async () => [
      { externalId: 'reczna/01', sku: 'LMP-01', name: 'Lampa Półcień', status: 'active', price: 9000, stock: 2 },
    ]),
    utworzProdukt: vi.fn(),
    zmienProdukt: vi.fn(),
    zmienProdukty: vi.fn(),
  };
  app = buildOmsServer({
    db,
    config: { auth: { user: 'operator', pass: 'atrapa' } },
    magazyn: { gotowy: () => true, stan: () => ({ trwa: false, kanaly: [] }) },
    nadpisania: {
      'kanaly.klienciKanalow': { [kanal]: klient },
      'kanaly.repozytoriumKanalow': {
        listaTypu: (typ) => (typ === 'erli' ? [{ klucz: kanal }] : []),
        zapisyZablokowane: () => false,
      },
    },
  });
  await app.ready();
  id = karta('LMP-01', '5900000000010');
  db.prepare(
    "INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, adres_zrodlowy, utworzono_at) VALUES (?, 0, 'woo', 'https://polcien.example/lampa.png', '2026-11-13')",
  ).run(id);
  zapiszUstawieniaOfertKonta(db, kanal, { stalaIlosc: 5, czasWysylkiDni: 2, cennikDostaw: 'Lampy', stawkaVat: '23' });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
  db.close();
});
it('pobiera tylko przez search, proponuje po EAN przed SKU; pomija znane identyfikatory', async () => {
  const drugi = karta('LMP-02', '5900000000027');
  klient.szukajProduktow.mockResolvedValue([
    { externalId: 'ean', ean: '5900000000027', sku: 'LMP-01', status: 'inactive' },
    { externalId: 'znana', sku: 'LMP-01', status: 'active' },
  ]);
  wstawOferte(db, { kartaId: id, kanal, idZewnetrzne: 'znana' });
  const r = await pobierz();
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain(`value="ean"`);
  expect(r.body).toContain(`/magazyn/${drugi}`);
  expect(r.body).not.toContain('value="znana"');
  expect(klient.szukajProduktow).toHaveBeenCalledTimes(1);
  for (const [n, f] of Object.entries(klient)) if (n !== 'szukajProduktow') expect(f).not.toHaveBeenCalled();
});
it('SKU i externalId działają, sama nazwa oraz niejednoznaczny EAN nie dają propozycji', async () => {
  karta('LMP-02', '5900000000010');
  klient.szukajProduktow.mockResolvedValue([
    { externalId: 'tylko-nazwa', name: 'Lampa Półcień', status: 'active' },
    { externalId: 'kolizja', ean: '5900000000010', sku: 'LMP-01', status: 'active' },
    { externalId: 'LMP-01', status: 'active' },
  ]);
  const r = await pobierz();
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain('Brak dopasowania po EAN lub SKU');
  expect(r.body).toContain('Niejednoznaczny EAN');
  expect(r.body).not.toContain('value="tylko-nazwa"');
  expect(r.body).not.toContain('value="kolizja"');
  expect(r.body).toContain('value="LMP-01"');
});
it('przejęcie zachowuje id, odczyt i tryb; ponowienie i podmieniona karta nie dublują', async () => {
  expect((await przejmij()).statusCode).toBe(409);
  await pobierz();
  const obca = karta('LMP-OBCA');
  expect(
    (
      await post('/magazyn/powiazania/erli/zatwierdz', {
        konto: kanal,
        zaznaczone: ['reczna/01'],
        kartaId: obca,
        price: 1,
        status: 'inactive',
      })
    ).statusCode,
  ).toBe(200);
  expect(ofertyKarty(db, id)).toEqual([
    expect.objectContaining({
      idZewnetrzne: 'reczna/01',
      tryb: 'obserwowana',
      pochodzenie: 'przejeta',
      stan: 'aktywna',
      odczytCenaGr: 9000,
      odczytIlosc: 2,
    }),
  ]);
  expect((await przejmij()).statusCode).toBe(200);
  expect(ofertyKarty(db, id)).toHaveLength(1);
  expect(ofertyKarty(db, obca)).toHaveLength(0);
  for (const [n, f] of Object.entries(klient)) if (n !== 'szukajProduktow') expect(f).not.toHaveBeenCalled();
});
it('objęcie wymaga świeżego podglądu, pokazuje dziś i cel, przelicza ponownie', async () => {
  await pobierz();
  await przejmij();
  const o = ofertyKarty(db, id)[0];
  expect((await post(`${objecie(o)}/zatwierdz`)).statusCode).toBe(409);
  const r = await post(`${objecie(o)}/podglad`);
  expect(r.statusCode).toBe(200);
  for (const s of ['90,00', '100,00', 'Ilość dziś: 2', 'Ilość po objęciu: 5']) expect(r.body).toContain(s);
  expect((await post(`${objecie(o)}/zatwierdz`, { podglad: token(r) })).statusCode).toBe(303);
  expect(ofertaPoId(db, o.id)).toMatchObject({ tryb: 'zarzadzana', stan: 'aktywna', odczytCenaGr: 9000 });
  for (const [n, f] of Object.entries(klient)) if (n !== 'szukajProduktow') expect(f).not.toHaveBeenCalled();
});
it('objęcie odmawia po zmianie karty i po 30 minutach', async () => {
  await pobierz();
  await przejmij();
  const o = ofertyKarty(db, id)[0];
  const r = await post(`${objecie(o)}/podglad`);
  const zegar = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60_000);
  expect((await post(`${objecie(o)}/zatwierdz`, { podglad: token(r) })).statusCode).toBe(409);
  zegar.mockRestore();
  db.prepare('UPDATE karty_produktow SET cena_gr = NULL WHERE id = ?').run(id);
  expect((await post(`${objecie(o)}/zatwierdz`, { podglad: token(r) })).statusCode).toBe(409);
  expect(ofertaPoId(db, o.id).tryb).toBe('obserwowana');
});
it('objęcie nieaktywnej oferty zachowuje stan i odczyt', async () => {
  klient.szukajProduktow.mockResolvedValue([
    { externalId: 'reczna/01', sku: 'LMP-01', status: 'inactive', price: 9000, stock: 2 },
  ]);
  await pobierz();
  await przejmij();
  const o = ofertyKarty(db, id)[0];
  const r = await post(`${objecie(o)}/podglad`);
  expect((await post(`${objecie(o)}/zatwierdz`, { podglad: token(r) })).statusCode).toBe(303);
  expect(ofertaPoId(db, o.id)).toMatchObject({
    tryb: 'zarzadzana',
    stan: 'nieaktywna',
    odczytStatus: 'inactive',
    idZewnetrzne: o.idZewnetrzne,
  });
});
it('transakcja przejęcia cofa pierwszą ofertę przy wyjątku drugiej', async () => {
  klient.szukajProduktow.mockResolvedValue([
    { externalId: 'reczna/01', sku: 'LMP-01', status: 'active' },
    { externalId: 'druga', sku: 'LMP-01', status: 'inactive' },
  ]);
  await pobierz();
  db.exec(
    "CREATE TRIGGER odmowa BEFORE INSERT ON oferty_kanalow WHEN NEW.id_zewnetrzne = 'druga' BEGIN SELECT RAISE(ABORT, 'awaria drugiej'); END",
  );
  expect((await przejmij(['reczna/01', 'druga'])).statusCode).toBe(500);
  expect(ofertyKarty(db, id)).toHaveLength(0);
});
it('transakcja E2.06 cofa pierwszą kartę przy wyjątku drugiej', async () => {
  const drugi = karta('LMP-02');
  db.prepare(
    'INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, adres_zrodlowy, utworzono_at) SELECT ?, 0, zrodlo, adres_zrodlowy, utworzono_at FROM zdjecia_kart WHERE karta_id = ?',
  ).run(drugi, id);
  const dane = { konto: kanal, zaznaczone: [id, drugi] };
  const r = await post('/magazyn/oferty/podglad', dane);
  db.exec(
    `CREATE TRIGGER odmowa BEFORE INSERT ON oferty_kanalow WHEN NEW.karta_id = ${drugi} BEGIN SELECT RAISE(ABORT, 'awaria drugiej'); END`,
  );
  expect((await post('/magazyn/oferty/zatwierdz', { ...dane, podglad: token(r) })).statusCode).toBe(500);
  expect(ofertyKarty(db, id)).toHaveLength(0);
});
it('201 pasujących odmawia przed liczeniem podglądu', async () => {
  for (let i = 0; i < 200; i++) karta(`LMP-${i + 10}`);
  const r = await post('/magazyn/oferty/podglad', { konto: kanal, zakres: 'pasujace' });
  expect(r.statusCode).toBe(400);
  expect(r.body).toContain('Za dużo kart naraz (201) — zawęź filtr do 200');
  expect(r.body).not.toContain('Dodaj co najmniej jedno zdjęcie');
  expect(db.prepare('SELECT count(*) n FROM oferty_kanalow').get().n).toBe(0);
});
it('dokładnie 200 pasujących kart pozwala obliczyć podgląd', async () => {
  for (let i = 0; i < 199; i++) karta(`LMP-limit-${i}`);
  const r = await post('/magazyn/oferty/podglad', { konto: kanal, zakres: 'pasujace' });
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain('Dodaj co najmniej jedno zdjęcie');
  expect(db.prepare('SELECT count(*) n FROM oferty_kanalow').get().n).toBe(0);
});
it('przejęcie pomija stany inne niż active i inactive', async () => {
  klient.szukajProduktow.mockResolvedValue(
    ['active', 'inactive', 'pending', undefined].map((status, i) => ({
      externalId: `stan-${i}`,
      sku: 'LMP-01',
      status,
    })),
  );
  await pobierz();
  expect((await przejmij(['stan-0', 'stan-1', 'stan-2', 'stan-3'])).statusCode).toBe(200);
  expect(ofertyKarty(db, id).map((o) => [o.idZewnetrzne, o.stan])).toEqual([
    ['stan-0', 'aktywna'],
    ['stan-1', 'nieaktywna'],
  ]);
});
it('podpis oferty A nie zatwierdza B, a zarządzanej nie można objąć ponownie', async () => {
  klient.szukajProduktow.mockResolvedValue(
    ['A', 'B'].map((externalId) => ({ externalId, sku: 'LMP-01', status: 'active', price: 9000, stock: 2 })),
  );
  await pobierz();
  await przejmij(['A', 'B']);
  const [a, b] = ofertyKarty(db, id);
  const r = await post(`${objecie(a)}/podglad`);
  expect((await post(`${objecie(b)}/zatwierdz`, { podglad: token(r) })).statusCode).toBe(409);
  expect(ofertaPoId(db, b.id).tryb).toBe('obserwowana');
  expect((await post(`${objecie(a)}/zatwierdz`, { podglad: token(r) })).statusCode).toBe(303);
  for (const akcja of ['podglad', 'zatwierdz'])
    expect((await post(`${objecie(a)}/${akcja}`, { podglad: token(r) })).statusCode).toBe(409);
});
it('odmawia drugiej zarządzanej oferty karty na konto, także gdy powstała po podglądzie', async () => {
  await pobierz();
  await przejmij();
  const o = ofertyKarty(db, id)[0];
  const r = await post(`${objecie(o)}/podglad`);
  wstawOferte(db, { kartaId: id, kanal, idZewnetrzne: 'inna-zarzadzana', tryb: 'zarzadzana', stan: 'aktywna' });
  for (const akcja of ['podglad', 'zatwierdz']) {
    const odmowa = await post(`${objecie(o)}/${akcja}`, { podglad: token(r) });
    expect(odmowa.statusCode).toBe(409);
    expect(odmowa.body).toContain('Karta ma już ofertę zarządzaną na tym koncie.');
  }
  expect(ofertaPoId(db, o.id).tryb).toBe('obserwowana');
});
it('zarządzana oferta karty na innym koncie ERLI nie blokuje objęcia', async () => {
  await pobierz();
  await przejmij();
  const o = ofertyKarty(db, id)[0];
  wstawOferte(db, {
    kartaId: id,
    kanal: 'erli-drugie',
    idZewnetrzne: 'inne-konto',
    tryb: 'zarzadzana',
    stan: 'aktywna',
  });
  const r = await post(`${objecie(o)}/podglad`);
  expect(r.statusCode).toBe(200);
  expect((await post(`${objecie(o)}/zatwierdz`, { podglad: token(r) })).statusCode).toBe(303);
  expect(ofertaPoId(db, o.id).tryb).toBe('zarzadzana');
});
it('po objęciu pętla aktualizuje istniejący produkt przez PATCH bez POST', async () => {
  await pobierz();
  await przejmij();
  const o = ofertyKarty(db, id)[0];
  const r = await post(`${objecie(o)}/podglad`);
  expect((await post(`${objecie(o)}/zatwierdz`, { podglad: token(r) })).statusCode).toBe(303);
  zapiszUstawieniaOfertKonta(db, kanal, { czynne: true });
  klient.zmienProdukt.mockResolvedValue({ updatedFields: ['name'] });
  klient.zmienProdukty.mockResolvedValue([
    { externalId: o.idZewnetrzne, status: 202, updatedFields: ['stock', 'price'] },
  ]);
  await createPetlaOfert({
    db,
    konta: () => [{ klucz: kanal, katalog: katalogErli(klient), tylkoOdczyt: () => false }],
    log: () => {},
  }).przebieg();
  expect(klient.utworzProdukt).not.toHaveBeenCalled();
  expect(klient.zmienProdukt).toHaveBeenCalledWith(
    o.idZewnetrzne,
    expect.objectContaining({ name: 'Lampa Półcień', sku: 'LMP-01' }),
  );
  expect(klient.zmienProdukty).toHaveBeenCalledWith([
    expect.objectContaining({ externalId: o.idZewnetrzne, stock: 5, price: 10000 }),
  ]);
  expect(ofertaPoId(db, o.id).stan).toBe('aktywna');
});
it('nie-admin i obcy CSRF nie pobierają ani nie przejmują', async () => {
  zalozKonto(db, { login: 'admin', imie: 'Admin', haslo: 'test', rola: 'admin', admin: true });
  const u = zalozKonto(db, { login: 'czytelnik', imie: 'Czytelnik', haslo: 'test', rola: 'operator' });
  ustawUprawnienia(db, u, ['magazyn']);
  const headers = {
    origin: 'http://localhost',
    cookie: `${NAZWA_CIASTECZKA_OMS}=${podpisz('czytelnik', wczytajSekret(db), Date.now(), 0)}`,
  };
  const o = wstawOferte(db, { kartaId: id, kanal, idZewnetrzne: 'ob', pochodzenie: 'przejeta' });
  for (const url of [
    '/magazyn/powiazania/erli/pobierz',
    '/magazyn/powiazania/erli/zatwierdz',
    `${objecie(o)}/podglad`,
    `${objecie(o)}/zatwierdz`,
  ]) {
    expect((await post(url, { konto: kanal }, headers)).statusCode).toBe(403);
    expect((await post(url, { konto: kanal }, { ...auth, origin: 'https://obcy.example' })).statusCode).toBe(403);
  }
  expect(klient.szukajProduktow).not.toHaveBeenCalled();
});
it('stronicuje kursorem z odpowiedzi i zatrzymuje odczyt na twardym limicie', async () => {
  klient.szukajProduktow.mockImplementation(async ({ pagination }) =>
    Array.from({ length: LIMIT_STRONY_PRZEJECIA }, (_, i) => ({
      externalId: `${pagination.after ?? 'start'}-${i}`,
      cursor: `kursor-${klient.szukajProduktow.mock.calls.length}`,
      sku: 'LMP-01',
      status: 'active',
    })),
  );
  const r = await pobierz();
  expect(r.statusCode).toBe(200);
  expect(klient.szukajProduktow).toHaveBeenCalledTimes(MAKS_STRON_PRZEJECIA);
  expect(klient.szukajProduktow.mock.calls[1][0].pagination.after).toBe('kursor-1');
  expect(r.body).toContain('Lista jest częściowa');
});
it('po pobraniu karta usunięta lub odczyt starszy niż 30 minut nie daje powiązania', async () => {
  await pobierz();
  db.prepare('DELETE FROM karty_produktow WHERE id = ?').run(id);
  expect((await przejmij()).statusCode).toBe(200);
  expect(db.prepare('SELECT count(*) n FROM oferty_kanalow').get().n).toBe(0);
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60_000);
  expect((await przejmij()).statusCode).toBe(409);
});
it('ekran powiązań ma pobranie per konto, karta ma przycisk objęcia obserwowanej', async () => {
  const r = await app.inject({ url: '/magazyn/powiazania', headers: auth });
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain('Pobierz oferty z ERLI');
  expect(r.body).toContain(`value="${kanal}"`);
  await pobierz();
  await przejmij();
  const k = await app.inject({ url: `/magazyn/${id}`, headers: auth });
  expect(k.statusCode).toBe(200);
  expect(k.body).toContain('Obejmij zarządzaniem');
  expect(k.body).toMatch(/<form class="w-linii" method="post" action="[^\"]+\/objecie\/podglad"/);
  expect(k.body).toContain('Zdjęcie wygenerowane lub istotnie zmienione przez AI'); // od E2.12b znacznik AI przy każdym zdjęciu, nie na karcie
});
it('karta nie proponuje objęcia ofert kont innych niż ERLI', async () => {
  wstawOferte(db, {
    kartaId: id,
    kanal: 'allegro-polcien',
    idZewnetrzne: 'inna',
    tryb: 'obserwowana',
    stan: 'aktywna',
  });
  const r = await app.inject({ url: `/magazyn/${id}`, headers: auth });
  expect(r.statusCode).toBe(200);
  expect(r.body).not.toContain('Obejmij zarządzaniem');
});
it('dwie różne karty po SKU produktu i externalId nie dają propozycji', async () => {
  karta('LMP-02');
  klient.szukajProduktow.mockResolvedValue([{ externalId: 'LMP-02', sku: 'LMP-01', status: 'active' }]);
  const r = await pobierz();
  expect(r.body).toContain('Niejednoznaczny SKU');
  expect(r.body).not.toContain('value="LMP-02"');
});
it('po pełnej stronie pobiera następną i kończy po niepełnej', async () => {
  klient.szukajProduktow
    .mockResolvedValueOnce(
      Array.from({ length: LIMIT_STRONY_PRZEJECIA }, (_, i) => ({ externalId: `LMP-strona-${i}`, status: 'inactive' })),
    )
    .mockResolvedValueOnce([]);
  expect((await pobierz()).statusCode).toBe(200);
  expect(klient.szukajProduktow).toHaveBeenCalledTimes(2);
  expect(klient.szukajProduktow.mock.calls[1][0].pagination.after).toBe(`LMP-strona-${LIMIT_STRONY_PRZEJECIA - 1}`);
});
