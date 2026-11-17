// Ekran „Problemy ofert”: lista ERLI i Allegro w jednej tabeli, Ponów (ponowienie operacji),
// Wznów (tylko zamiar `wyslanePola.wznow`) i Potwierdź cenę. Klienci kanałów to atrapy —
// żadna trasa nie woła Allegro ani ERLI. Dane zmyślone („Pracownia Półcień”).
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { definicjeKanalowHistoryczne } from '../../pomoc/przykladowe-definicje-kanalow.js';
import { szyfrTestowy } from '../../pomoc/sejf-testowy.ts';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import { wstawOferte, zmienOferte, ofertaPoId } from '../../../src/oms/db/oferty-kanalow.ts';
import { BRAK_ZGODY_OFERT } from '../../../src/moduly/kanaly/services/oferty-allegro-ustawienia.ts';
import { zalozKonto, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { podpisz, NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';
import { wczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import { registerProblemyOfert } from '../../../src/moduly/magazyn/problemy-ofert.js';

const KONTO = 'allegro_swietlik';      // zgoda na oferty
const BEZ_ZGODY = 'allegro_polcien2';  // token bez zakresów ofert
const ODLACZONE = 'allegro_dawne';     // konta już nie ma w konfiguracji
const ERLI = 'erli-polcien';
const T0 = '2026-11-14T08:00:00.000Z';
const T1 = '2026-11-14T09:30:00.000Z';
const OFERTY = ['allegro:api:sale:offers:write', 'allegro:api:sale:settings:read'];
const jwt = scope => ['e30', Buffer.from(JSON.stringify({ scope })).toString('base64url'), 'podpis'].join('.');
const auth = { authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}`, origin: 'http://localhost' };

let db, app, klienci;
const post = (url, payload = {}, headers = auth) => app.inject({ method: 'POST', url, payload, headers });
const get = (url, headers = auth) => app.inject({ method: 'GET', url, headers });
const wywolania = () => Object.values(klienci).flatMap(k => Object.entries(k).filter(([, f]) => f.mock.calls.length).map(([n]) => n));
const atrapa = () => ({
  podgladOplat: vi.fn(), utworzOferte: vi.fn(), zmienOferte: vi.fn(), zmienStatusOferty: vi.fn(),
  komendaIlosci: vi.fn(), komendaCeny: vi.fn(), pobierzOferte: vi.fn(), wgrajZdjecie: vi.fn(),
});
const tokeny = (kanal, scope) => db.prepare(`INSERT OR REPLACE INTO tokeny_kanalu (kanal, access_token, refresh_token, wygasa_at, refresh_wygasa_at, zaktualizowane_at)
  VALUES (?, ?, ?, '2026-11-14T11:00:00Z', '2027-01-01T00:00:00Z', '2026-11-14T10:00:00Z')`).run(kanal,
  szyfrTestowy(db, 'tokeny_kanalu', 'access_token', kanal, jwt(scope)), szyfrTestowy(db, 'tokeny_kanalu', 'refresh_token', kanal, 'REFRESH-ATRAPA'));
const karta = n => utworzKarte(db, { nazwa: `Lampa stołowa Gliwka ${n}`, sku: `GLW-${n}`, cena_gr: 9900, stawka_vat: '23', marka: 'Pracownia Półcień' });
const oferta = (kanal, { stan = 'problem', kartaId = karta(kanal), id = `TEST-${kanal}`, ...zmiany } = {}, teraz = T0) => {
  const o = wstawOferte(db, { kartaId, kanal, idZewnetrzne: id, stan, pochodzenie: 'oms', tryb: 'zarzadzana' }, { teraz });
  return zmienOferte(db, o.id, zmiany, { teraz });
};
/** Allegro zakończona ręcznie — bez prognozy opłaty. */
const zakonczonaRecznie = (kanal = KONTO) => oferta(kanal, { odczytStatus: 'ENDED', odczytIlosc: 0, problemy: [{ kod: 'zakonczona', sztuk: 0,
  tekst: 'Oferta zakończona ręcznie.' }] });
const cenaErli = () => oferta(ERLI, { stan: 'aktywna', odczytCenaGr: 9900, cenaDoPotwierdzeniaGr: 12900,
  problemy: [{ kod: 'cena', tekst: 'Zmiana ceny przekracza próg — czeka na potwierdzenie, do ERLI nic nie poszło.' }] });
const ciasteczko = login => ({ origin: 'http://localhost', cookie: `${NAZWA_CIASTECZKA_OMS}=${podpisz(login, wczytajSekret(db), Date.now(), 0)}` });

beforeEach(async () => {
  db = openOmsDb(':memory:');
  const atrapaErli = { utworzProdukt: vi.fn(), zmienProdukt: vi.fn(), pobierzProdukt: vi.fn() };
  klienci = { [KONTO]: atrapa(), [BEZ_ZGODY]: atrapa(), [ERLI]: atrapaErli };
  const kontaAllegro = [
    { klucz: KONTO, nazwa: 'Świetlik', autoryzacja: 'polaczone', srodowisko: 'produkcja' },
    { klucz: BEZ_ZGODY, nazwa: 'Półcień Druga', autoryzacja: 'polaczone', srodowisko: 'produkcja' },
  ];
  app = buildOmsServer({ db, config: { auth: { user: 'operator', pass: 'atrapa' },
    definicje: [...definicjeKanalowHistoryczne, { klucz: ERLI, typ: 'erli', prefiks: 'ERLI_POLCIEN', etykieta: 'ERLI Półcień' }] },
    magazyn: { stan: () => ({ trwa: false, kanaly: [] }) },
    nadpisania: { 'kanaly.klienciKanalow': klienci, 'kanaly.repozytoriumKanalow': {
      listaTypu: typ => (typ === 'allegro' ? kontaAllegro : typ === 'erli' ? [{ klucz: ERLI, nazwa: 'Półcień' }] : []),
      zapisyZablokowane: () => false, konfliktKlucza: () => false,
    } },
  });
  await app.ready();
  tokeny(KONTO, ['allegro:api:orders:read', ...OFERTY]);
  tokeny(BEZ_ZGODY, ['allegro:api:orders:read']);
});
afterEach(async () => { await app.close(); db.close(); });

it('ERLI i Allegro w jednej tabeli: kanał, konto, powód po polsku, „od kiedy”; przyciski według wiersza', async () => {
  const cena = cenaErli();
  const zak = zakonczonaRecznie();
  const kom = oferta(KONTO, { id: 'TEST-kom', kartaId: karta('k'), odczytStatus: 'ACTIVE',
    problemy: [{ kod: 'komenda', rodzaj: 'ilosc', tekst: 'Allegro odrzuciło zmianę ilości.' }] }, T1);
  const odl = oferta(ODLACZONE, { problemy: [{ kod: 'walidacja', bledy: [] }] });
  const r = await get('/magazyn/problemy-ofert');
  expect(r.statusCode).toBe(200);
  const wiersz = o => new RegExp(`<tr[^>]*id="oferta-${o.id}"[^>]*>([\\s\\S]*?)</tr>`).exec(r.body)?.[1] ?? '';
  expect(wiersz(cena)).toContain('ERLI');
  expect(wiersz(cena)).toContain(ERLI);
  expect(wiersz(cena)).toContain('Lampa stołowa Gliwka erli-polcien');
  expect(wiersz(cena)).toContain('Nowa cena 129,00 zł (dziś 99,00 zł) — zmiana ponad próg');
  expect(wiersz(cena)).toContain('14.11.2026 09:00');
  expect(wiersz(cena)).toContain(`action="/magazyn/problemy-ofert/${cena.id}/potwierdz-cene"`);
  expect(wiersz(cena)).toContain('name="cenaGr" value="12900"');
  expect(wiersz(cena)).not.toContain('/ponow"');
  expect(wiersz(zak)).toContain('Allegro');
  expect(wiersz(zak)).toContain(`action="/magazyn/problemy-ofert/${zak.id}/wznow"`);
  expect(r.body).not.toContain('Prognoza opłaty');
  expect(wiersz(zak)).toContain('Oferta zakończona ręcznie.');
  expect(wiersz(zak)).not.toContain('name="zgoda"');
  expect(wiersz(zak)).not.toContain('/ponow"');
  expect(wiersz(kom)).toContain('Allegro odrzuciło zmianę ilości.');
  expect(wiersz(kom)).toContain('14.11.2026 10:30');
  expect(wiersz(kom)).toContain(`action="/magazyn/problemy-ofert/${kom.id}/ponow"`);
  expect(wiersz(odl)).toContain('konto odłączone');
  expect(wiersz(odl)).toContain('Oferta nie przeszła walidacji');
  expect(wiersz(odl)).not.toContain('<form');
  // Najstarsze „od” najpierw; komenda (T1) po wierszach z T0.
  expect(r.body.indexOf(`id="oferta-${kom.id}"`)).toBeGreaterThan(r.body.indexOf(`id="oferta-${zak.id}"`));
  expect(r.body).toContain('href="/magazyn/1#produkty-karty"');
  for (const [o, nazwa] of [[zak, 'Wznów ofertę'], [kom, 'Ponów ofertę'], [cena, 'Potwierdź cenę 129,00 zł dla']]) {
    expect(wiersz(o)).toMatch(new RegExp(`<button[^>]*aria-label="${nazwa} Lampa stołowa Gliwka`));
    expect(wiersz(o)).not.toMatch(/<form[^>]*aria-label=/);
  }
  expect(wywolania()).toEqual([]);
});

it('Wznów zakończonej ręcznie (3 szt.): przycisk bez prognozy, POST ustawia flagę', async () => {
  const o = oferta(KONTO, { odczytStatus: 'ENDED', odczytIlosc: 3, problemy: [{ kod: 'zakonczona', sztuk: 3 }] });
  const r = await get('/magazyn/problemy-ofert');
  expect(r.body).toContain(`action="/magazyn/problemy-ofert/${o.id}/wznow"`);
  expect(r.body).not.toContain('Prognoza opłaty');
  expect((await post(`/magazyn/problemy-ofert/${o.id}/wznow`)).statusCode).toBe(303);
  expect(ofertaPoId(db, o.id).wyslanePola.wznow).toMatchObject({ login: 'operator' });
});

it('pusta strona, gdy nic nie czeka na decyzję', async () => {
  oferta(KONTO, { stan: 'aktywna' });
  const r = await get('/magazyn/problemy-ofert');
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain('Żadna oferta nie czeka na decyzję');
  expect(r.body).not.toContain('<table');
});

it('napis „pokazano 200 z N”, gdy ofert jest więcej niż limit', async () => {
  for (let i = 0; i < 201; i++) oferta(KONTO, { id: `TEST-L${i}`, kartaId: karta(`L${i}`), problemy: [{ kod: 'walidacja' }] });
  const r = await get('/magazyn/problemy-ofert');
  expect(r.body).toContain('pokazano 200 z 201');
  expect(r.body.match(/<tr[^>]*id="oferta-/g)).toHaveLength(200);
});

it('listy kont są liczone raz na żądanie, także przy wielu wierszach; kolejne żądanie ma świeże konta', async () => {
  zakonczonaRecznie();
  cenaErli();
  oferta(KONTO, { id: 'TEST-kolejna', kartaId: karta('kolejna'), problemy: [{ kod: 'komenda' }] });
  let lista;
  const allegro = vi.fn(() => [{ klucz: KONTO }]);
  const erli = vi.fn(() => [{ klucz: ERLI }]);
  registerProblemyOfert({ get: (_adres, obsluga) => { lista = obsluga; }, post: () => {} },
    { db, pomoc: {}, kontaAllegro: allegro, kontaErli: erli });
  const view = vi.fn((_szablon, dane) => dane);
  const r = await lista({ konto: { admin: true } }, { view });
  expect(r.wiersze).toHaveLength(3);
  expect(allegro).toHaveBeenCalledTimes(1);
  expect(erli).toHaveBeenCalledTimes(1);
  allegro.mockReturnValue([]);
  const drugi = await lista({ konto: { admin: true } }, { view });
  expect(drugi.wiersze.filter(w => w.konto === KONTO).every(w => w.kanal === 'konto odłączone' && !w.wznow && !w.ponow)).toBe(true);
  expect(allegro).toHaveBeenCalledTimes(2);
  expect(erli).toHaveBeenCalledTimes(2);
});

it('Potwierdź cenę: zapis cenaPotwierdzonaGr; zła kwota 409; drugie kliknięcie 303 bez zmian', async () => {
  const o = cenaErli();
  expect((await post(`/magazyn/problemy-ofert/${o.id}/potwierdz-cene`, { cenaGr: '12000' })).statusCode).toBe(409);
  expect(ofertaPoId(db, o.id).wyslanePola?.cenaPotwierdzonaGr).toBeUndefined();
  const r = await post(`/magazyn/problemy-ofert/${o.id}/potwierdz-cene`, { cenaGr: '12900' });
  expect(r.statusCode).toBe(303);
  expect(r.headers.location).toBe('/magazyn/problemy-ofert');
  const po = ofertaPoId(db, o.id);
  expect(po.wyslanePola.cenaPotwierdzonaGr).toBe(12900);
  expect(po.nastepnaProbaAt).toBe(o.nastepnaProbaAt);
  expect((await post(`/magazyn/problemy-ofert/${o.id}/potwierdz-cene`, { cenaGr: '12900' })).statusCode).toBe(303);
  expect(ofertaPoId(db, o.id)).toEqual(po);
  // Potwierdzona — ekran już nie pokazuje przycisku.
  expect((await get('/magazyn/problemy-ofert')).body).not.toContain(`/${o.id}/potwierdz-cene`);
  expect(wywolania()).toEqual([]);
});

it('Wznów (decyzja właściciela 14.11: bez sprawdzania opłat): flaga bez kwoty i bez zgody; drugie kliknięcie bez zmian', async () => {
  const o = zakonczonaRecznie();
  zmienOferte(db, o.id, { liczbaProb: 3, nastepnaProbaAt: '2026-11-14T12:00:00.000Z', wyslanePola: { produktId: '42' } });
  const r = await post(`/magazyn/problemy-ofert/${o.id}/wznow`);
  expect(r.statusCode).toBe(303);
  expect(r.headers.location).toBe('/magazyn/problemy-ofert');
  const po = ofertaPoId(db, o.id);
  expect(po.wyslanePola).toEqual({ produktId: '42', wznow: { login: 'operator', at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) } });
  expect(po).toMatchObject({ liczbaProb: 0, nastepnaProbaAt: null, stan: 'problem' });
  expect((await post(`/magazyn/problemy-ofert/${o.id}/wznow`)).statusCode).toBe(303);
  expect(ofertaPoId(db, o.id)).toEqual(po);
  expect((await get('/magazyn/problemy-ofert')).body).not.toContain(`/${o.id}/wznow"`);
  expect(wywolania()).toEqual([]);
});

it('Wznów: konto bez zgody 400, ERLI i zakończona bez decyzji pętli 409, oferta poza problemem 303', async () => {
  const bez = zakonczonaRecznie(BEZ_ZGODY);
  const r = await post(`/magazyn/problemy-ofert/${bez.id}/wznow`);
  expect(r.statusCode).toBe(400);
  expect(r.body).toContain(BRAK_ZGODY_OFERT);
  const erli = oferta(ERLI, { problemy: [{ kod: 'zakonczona', sztuk: 2 }] });
  expect((await post(`/magazyn/problemy-ofert/${erli.id}/wznow`)).statusCode).toBe(409);
  const czeka = oferta(KONTO, { id: 'TEST-czeka', kartaId: karta('c'), problemy: [{ kod: 'zakonczona', sztuk: 0 }] });
  expect((await post(`/magazyn/problemy-ofert/${czeka.id}/wznow`)).statusCode).toBe(409);
  const zdejmowana = oferta(KONTO, { id: 'TEST-zd', kartaId: karta('z'), problemy: [{ kod: 'zakonczona', sztuk: 2 }], wyslanePola: { zdejmij: true } });
  expect((await post(`/magazyn/problemy-ofert/${zdejmowana.id}/wznow`)).statusCode).toBe(409);
  const aktywna = oferta(KONTO, { id: 'TEST-akt', kartaId: karta('a'), stan: 'aktywna' });
  expect((await post(`/magazyn/problemy-ofert/${aktywna.id}/wznow`)).statusCode).toBe(303);
  for (const x of [bez, erli, czeka, zdejmowana, aktywna]) expect(ofertaPoId(db, x.id).wyslanePola?.wznow).toBeUndefined();
  expect(wywolania()).toEqual([]);
});

it('Ponów na komendzie idzie ścieżką E3.27 (bez POST); na zakończonej brak przycisku na ekranie i karcie, POST 409', async () => {
  const kom = oferta(KONTO, { id: '7700012345', kartaId: karta('kom'), odczytStatus: 'ACTIVE', liczbaProb: 5,
    problemy: [{ kod: 'komenda', rodzaj: 'ilosc', tekst: 'Odrzucona' }], wyslanePola: { komendaIlosci: { id: 'k-1', wartosc: 4 }, produktId: '42' } });
  expect((await post(`/magazyn/problemy-ofert/${kom.id}/ponow`)).statusCode).toBe(303);
  expect(ofertaPoId(db, kom.id)).toMatchObject({ stan: 'aktywna', liczbaProb: 0, problemy: [], wyslanePola: { produktId: '42' } });
  expect(ofertaPoId(db, kom.id).wyslanePola.komendaIlosci).toBeUndefined();
  // Drugie kliknięcie: oferta wyszła ze stanu problemu → 303 bez zmian.
  const po = ofertaPoId(db, kom.id);
  expect((await post(`/magazyn/problemy-ofert/${kom.id}/ponow`)).statusCode).toBe(303);
  expect(ofertaPoId(db, kom.id)).toEqual(po);

  const zak = zakonczonaRecznie();
  expect((await get('/magazyn/problemy-ofert')).body).not.toContain(`/${zak.id}/ponow"`);
  expect((await get(`/magazyn/${zak.kartaId}`)).body).not.toContain(`/oferty/${zak.id}/ponow"`);
  expect((await post(`/magazyn/problemy-ofert/${zak.id}/ponow`)).statusCode).toBe(409);
  expect((await post(`/magazyn/${zak.kartaId}/oferty/${zak.id}/ponow`)).statusCode).toBe(409);
  expect(ofertaPoId(db, zak.id).stan).toBe('problem');
  const odl = oferta(ODLACZONE, { problemy: [{ kod: 'walidacja' }] });
  expect((await post(`/magazyn/problemy-ofert/${odl.id}/ponow`)).statusCode).toBe(409);
  expect(ofertaPoId(db, odl.id).stan).toBe('problem');
  expect(wywolania()).toEqual([]);
});

it('nie-admin z prawem magazynu dostaje 403 na GET i każdym POST; obcy Origin 403; nic się nie zmienia', async () => {
  const cena = cenaErli();
  const zak = zakonczonaRecznie();
  const kom = oferta(KONTO, { id: 'TEST-kom', kartaId: karta('k'), problemy: [{ kod: 'komenda', tekst: 'Odrzucona' }] });
  const posty = [[`/magazyn/problemy-ofert/${kom.id}/ponow`, {}],
    [`/magazyn/problemy-ofert/${zak.id}/wznow`, {}],
    [`/magazyn/problemy-ofert/${cena.id}/potwierdz-cene`, { cenaGr: '12900' }]];
  const przed = [cena, zak, kom].map(o => ofertaPoId(db, o.id));
  for (const [url, dane] of posty) expect((await post(url, dane, { ...auth, origin: 'https://obcy.example' })).statusCode).toBe(403);
  zalozKonto(db, { login: 'admin', imie: 'Admin', haslo: 'test', rola: 'admin', admin: true });
  const user = zalozKonto(db, { login: 'czytelnik', imie: 'Czytelnik', haslo: 'test', rola: 'operator' });
  ustawUprawnienia(db, user, ['magazyn']);
  const naglowki = ciasteczko('czytelnik');
  expect((await get('/magazyn/problemy-ofert', naglowki)).statusCode).toBe(403);
  for (const [url, dane] of posty) expect((await post(url, dane, naglowki)).statusCode).toBe(403);
  expect([cena, zak, kom].map(o => ofertaPoId(db, o.id))).toEqual(przed);
  // Admin z ciasteczkiem widzi ekran.
  expect((await get('/magazyn/problemy-ofert', ciasteczko('admin'))).statusCode).toBe(200);
  expect(wywolania()).toEqual([]);
});

it('Wznów: oferta obserwowana → 409 i cały wiersz bez zmian', async () => {
  const o = zakonczonaRecznie();
  db.prepare("UPDATE oferty_kanalow SET tryb = 'obserwowana' WHERE id = ?").run(o.id);
  const przed = db.prepare('SELECT * FROM oferty_kanalow WHERE id = ?').get(o.id);
  expect((await post(`/magazyn/problemy-ofert/${o.id}/wznow`)).statusCode).toBe(409);
  expect(db.prepare('SELECT * FROM oferty_kanalow WHERE id = ?').get(o.id)).toEqual(przed);
  expect(wywolania()).toEqual([]);
});

it('Potwierdź cenę: oferta obserwowana → 409 i cały wiersz bez zmian', async () => {
  const o = cenaErli();
  db.prepare("UPDATE oferty_kanalow SET tryb = 'obserwowana' WHERE id = ?").run(o.id);
  const przed = db.prepare('SELECT * FROM oferty_kanalow WHERE id = ?').get(o.id);
  expect((await post(`/magazyn/problemy-ofert/${o.id}/potwierdz-cene`, { cenaGr: '12900' })).statusCode).toBe(409);
  expect(db.prepare('SELECT * FROM oferty_kanalow WHERE id = ?').get(o.id)).toEqual(przed);
  expect(wywolania()).toEqual([]);
});
