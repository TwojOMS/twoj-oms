// PRZ-160.E3c — poprawki z odbioru E3: N5 (Ponów na `duplikat`), N6 (trzy trasy zapisu Allegro tylko dla admina,
// `allegro/produkt` bez wiersza z numerem), N7 (ekran wycofania mówi o kontach ze wstrzymanymi ofertami).
// Klienci Allegro to atrapy (fixture P9) — żadna trasa nie łączy się z Allegro. Dane zmyślone („Pracownia Półcień”).
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { definicjeKanalowHistoryczne } from '../../pomoc/kanaly-historyczne-fixture.js';
import { szyfrTestowy } from '../../pomoc/sejf-testowy.ts';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import { wstawOferte, zmienOferte, ofertaPoId, zapiszUstawieniaOfertKonta } from '../../../src/oms/db/oferty-kanalow.ts';
import { zalozKonto, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { podpisz, NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';
import { wczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';

const P9 = JSON.parse(readFileSync(new URL('../../fixtures/allegro/e3-pomiar-p9-kategoria.json', import.meta.url), 'utf8'));
const KATEGORIE = Object.fromEntries(P9.sciezka.map(k => [k.id, k]));
const CZYNNE = 'allegro-polcien';        // oferty czynne, zapisy wolne
const WSTRZYMANE = 'allegro-polcien-2';  // oferty_czynne = 0
const ODCZYT = 'allegro-polcien-3';      // oferty czynne, ale zapisy zablokowane (tryb tylko odczyt)
const ADRES_KATEGORII = `/magazyn/kategorie/${encodeURIComponent('Lampy stołowe')}/allegro`;
const ADRES_MARKI = `/magazyn/marki/${encodeURIComponent('Pracownia Półcień')}/allegro`;
const PELNY_ZAKRES = ['allegro:api:sale:offers:read', 'allegro:api:sale:offers:write', 'allegro:api:sale:settings:read'];
const DUPLIKAT = { kod: 'duplikat', oferty: [{ id: '7700000001', nazwa: 'Lampa Gliwka', status: 'INACTIVE' },
  { id: '7700000002', nazwa: 'Lampa Gliwka', status: 'ACTIVE' }] };
const WIELE = { kod: 'wiele-produktow', produkty: [{ id: 'prod-1', nazwa: 'Lampa Gliwka biała', ean: null }] };
const OSTRZEZENIE = /nie zostaną zakończone, dopóki/;
const jwt = scope => ['e30', Buffer.from(JSON.stringify({ scope })).toString('base64url'), 'podpis'].join('.');

const atrapaKlienta = () => ({
  pobierzKategorie: vi.fn(async id => {
    if (!KATEGORIE[id]) throw Object.assign(new Error('nie ma'), { status: 404 });
    return structuredClone(KATEGORIE[id]);
  }),
  pobierzParametryKategorii: vi.fn(async () => structuredClone(P9.parametry)),
  dopasujKategorie: vi.fn(async () => []),
});

let db, app, klienci, admin, operator, kartaId;
const post = (url, payload, headers) => app.inject({ method: 'POST', url, payload, headers });
const get = (url, headers) => app.inject({ url, headers });
const kartaAllegro = () => db.prepare('SELECT * FROM karty_allegro WHERE karta_id = ?').get(kartaId);
const mapa = () => db.prepare('SELECT kategoria_karty, srodowisko, kategoria_allegro_id FROM allegro_mapa_kategorii').all();
const oferta = (kanal, idZewnetrzne, zmiany = {}) => {
  const o = wstawOferte(db, { kartaId, kanal, idZewnetrzne, stan: 'problem', pochodzenie: 'oms', tryb: 'zarzadzana' });
  return zmienOferte(db, o.id, zmiany);
};
const reguly = () => db.prepare('SELECT parametr_id, potwierdzil FROM allegro_reguly_parametrow').all();
const marki = () => db.prepare('SELECT marka, wartosc_id FROM allegro_marki').all();
const tokenKonta = (k, scope) => db.prepare(`INSERT OR REPLACE INTO tokeny_kanalu (kanal, access_token, refresh_token, wygasa_at, refresh_wygasa_at, zaktualizowane_at)
  VALUES (?, ?, ?, '2026-11-14T11:00:00Z', '2027-01-01T00:00:00Z', '2026-11-14T10:00:00Z')`).run(k,
  szyfrTestowy(db, 'tokeny_kanalu', 'access_token', k, jwt(scope)), szyfrTestowy(db, 'tokeny_kanalu', 'refresh_token', k, 'REFRESH-ATRAPA'));
const sekcjaSprzedazy = body => body.match(/<section[^>]*id="sprzedaz-karty"[\s\S]*?<\/section>/)?.[0] ?? '';

beforeEach(async () => {
  db = openOmsDb(':memory:');
  klienci = { [CZYNNE]: atrapaKlienta(), [WSTRZYMANE]: atrapaKlienta(), [ODCZYT]: atrapaKlienta() };
  const konta = [CZYNNE, WSTRZYMANE, ODCZYT].map(klucz => ({ klucz, nazwa: klucz, autoryzacja: 'polaczone', srodowisko: 'produkcja' }));
  app = buildOmsServer({ db, config: { auth: { user: 'operator', pass: 'atrapa' }, definicje: definicjeKanalowHistoryczne },
    magazyn: { stan: () => ({ trwa: false, kanaly: [] }) },
    nadpisania: { 'kanaly.klienciKanalow': klienci, 'kanaly.repozytoriumKanalow': {
      listaTypu: typ => (typ === 'allegro' ? konta : []), zapisyZablokowane: klucz => klucz === ODCZYT, konfliktKlucza: () => false,
    } },
  });
  await app.ready();
  const konto = (login, czyAdmin, prawa) => {
    const id = zalozKonto(db, { login, imie: login, haslo: 'atrapa-testowa', rola: 'operator', admin: czyAdmin });
    ustawUprawnienia(db, id, prawa);
    return { origin: 'http://localhost', cookie: `${NAZWA_CIASTECZKA_OMS}=${podpisz(login, wczytajSekret(db), Date.now(), 0)}` };
  };
  admin = konto('administrator-testowy', true, []);
  operator = konto('sprzedawca-testowy', false, ['magazyn']);
  // Wszystkie konta mają zgodę na oferty (offers:write + settings:read) — wstrzymanie wynika tylko z ustawień konta.
  for (const k of [CZYNNE, WSTRZYMANE, ODCZYT]) tokenKonta(k, PELNY_ZAKRES);
  zapiszUstawieniaOfertKonta(db, CZYNNE, { czynne: true });
  zapiszUstawieniaOfertKonta(db, ODCZYT, { czynne: true });
  db.prepare('INSERT OR IGNORE INTO kategorie_kart (nazwa, utworzona_at) VALUES (?, ?)').run('Lampy stołowe', '2026-11-01T10:00:00Z');
  db.prepare('INSERT OR IGNORE INTO marki (nazwa, utworzona_at) VALUES (?, ?)').run('Pracownia Półcień', '2026-11-01T10:00:00Z');
  kartaId = utworzKarte(db, { nazwa: 'Lampa stołowa Gliwka', sku: 'GLW-1', kategoria_glowna: 'Lampy stołowe', marka: 'Pracownia Półcień' });
});
afterEach(async () => { await app?.close(); db?.close(); });

// ——— N5 ———
it('N5: Ponów na problemie `duplikat` → 409 na karcie i na ekranie problemów, wiersz bez zmian', async () => {
  const o = oferta(CZYNNE, 'ext:gliwka-1', { problemy: [DUPLIKAT], liczbaProb: 2 });
  for (const url of [`/magazyn/${kartaId}/oferty/${o.id}/ponow`, `/magazyn/problemy-ofert/${o.id}/ponow`]) {
    const r = await post(url, {}, admin);
    expect(r.statusCode).toBe(409);
    expect(ofertaPoId(db, o.id)).toEqual(o);
  }
});

it('N5: zamiast Ponów zdanie o wyborze jednej z ofert (karta i ekran problemów); inny problem dalej ma Ponów', async () => {
  const dup = oferta(CZYNNE, 'ext:gliwka-1', { problemy: [DUPLIKAT] });
  const karta = (await get(`/magazyn/${kartaId}`, admin)).body;
  expect(karta).not.toContain(`/oferty/${dup.id}/ponow`);
  expect(karta).toContain('Wybierz jedną z ofert w Allegro');
  const problemy = (await get('/magazyn/problemy-ofert', admin)).body;
  expect(problemy).not.toContain(`/problemy-ofert/${dup.id}/ponow`);
  expect(problemy).toContain('Wybierz jedną z ofert w Allegro');
  const inny = oferta(WSTRZYMANE, 'ext:gliwka-2', { problemy: [{ kod: 'walidacja', tekst: 'Allegro odrzuciło ofertę.' }] });
  expect((await get(`/magazyn/${kartaId}`, admin)).body).toContain(`/oferty/${inny.id}/ponow`);
  expect((await get('/magazyn/problemy-ofert', admin)).body).toContain(`/problemy-ofert/${inny.id}/ponow`);
});

// ——— N6 ———
it('N6: konto z prawem `magazyn` bez admina → 403 na trzech trasach zapisu Allegro i brak zapisu', async () => {
  const o = oferta(CZYNNE, 'ext:gliwka-1', { problemy: [WIELE] });
  const r1 = await post(`/magazyn/${kartaId}/allegro`, { nazwa: 'Lampa Gliwka nowa' }, operator);
  const r2 = await post(`/magazyn/${kartaId}/allegro/produkt`, { ofertaId: String(o.id), produktId: 'prod-1' }, operator);
  const r3 = await post(ADRES_KATEGORII, { srodowisko: 'produkcja', kategoria_id: '257' }, operator);
  for (const r of [r1, r2, r3]) {
    expect(r.statusCode).toBe(403);
    expect(r.body).toContain('Tylko administrator');
  }
  expect(kartaAllegro()).toBeUndefined();
  expect(ofertaPoId(db, o.id)).toEqual(o);
  expect(mapa()).toEqual([]);
  expect(klienci[CZYNNE].pobierzKategorie).not.toHaveBeenCalled();
});

it('N6: admin zapisuje jak dotąd (dane Allegro, wybór produktu, mapa kategorii)', async () => {
  const o = oferta(CZYNNE, 'ext:gliwka-1', { problemy: [WIELE] });
  expect((await post(`/magazyn/${kartaId}/allegro`, { nazwa: 'Lampa Gliwka nowa' }, admin)).statusCode).toBe(303);
  expect(kartaAllegro()).toMatchObject({ nazwa: 'Lampa Gliwka nowa' });
  expect((await post(`/magazyn/${kartaId}/allegro/produkt`, { ofertaId: String(o.id), produktId: 'prod-1' }, admin)).statusCode).toBe(303);
  expect(ofertaPoId(db, o.id)).toMatchObject({ stan: 'do_wyslania' });
  expect(kartaAllegro()).toMatchObject({ produkt_id: 'prod-1' });
  expect((await post(ADRES_KATEGORII, { srodowisko: 'produkcja', kategoria_id: '257' }, admin)).statusCode).toBe(303);
  expect(mapa()).toEqual([{ kategoria_karty: 'Lampy stołowe', srodowisko: 'produkcja', kategoria_allegro_id: '257' }]);
});

it('N6: `allegro/produkt` na wierszu z numerem Allegro → 409 z polskim komunikatem, bez zapisu', async () => {
  const o = oferta(CZYNNE, '7700000003', { problemy: [WIELE] });
  const r = await post(`/magazyn/${kartaId}/allegro/produkt`, { ofertaId: String(o.id), produktId: 'prod-1' }, admin);
  expect(r.statusCode).toBe(409);
  expect(r.body).toContain('ma już numer w Allegro');
  expect(kartaAllegro()).toBeUndefined();
  expect(ofertaPoId(db, o.id)).toEqual(o);
});

it('N6: formularze tras zapisu Allegro tylko na ekranie admina', async () => {
  oferta(CZYNNE, 'ext:gliwka-1', { problemy: [WIELE] });
  const akcje = [`action="/magazyn/${kartaId}/allegro"`, `action="/magazyn/${kartaId}/allegro/produkt"`];
  const dlaAdmina = (await get(`/magazyn/${kartaId}`, admin)).body;
  for (const a of akcje) expect(dlaAdmina).toContain(a);
  const dlaOperatora = await get(`/magazyn/${kartaId}`, operator);
  expect(dlaOperatora.statusCode).toBe(200);
  for (const a of akcje) expect(dlaOperatora.body).not.toContain(a);
  expect(dlaOperatora.body).toContain('Oferta na koncie allegro-polcien czeka na wybór produktu');
  const formularzMapy = `<form method="post" action="${ADRES_KATEGORII}"`;
  expect((await get(ADRES_KATEGORII, admin)).body).toContain(formularzMapy);
  const kategoriaOperatora = await get(ADRES_KATEGORII, operator);
  expect(kategoriaOperatora.statusCode).toBe(200);
  expect(kategoriaOperatora.body).not.toContain(formularzMapy);
  expect(kategoriaOperatora.body).toContain('Kategorię Allegro zatwierdza administrator');
});

it('N6 (T2): reguła parametru kategorii i marka Allegro — nie-admin 403 bez zapisu i bez pytania Allegro, admin 303', async () => {
  expect((await post(ADRES_KATEGORII, { srodowisko: 'produkcja', kategoria_id: '257' }, admin)).statusCode).toBe(303);
  klienci[CZYNNE].pobierzParametryKategorii.mockClear();
  const regulyPrzed = reguly(); // zatwierdzenie kategorii samo zakłada regułę „Stan”
  const regula = { srodowisko: 'produkcja', parametr_id: '224017', rodzaj: 'stala', wartosc: 'GLW-KOD-1' };
  const marka = { srodowisko: 'produkcja', parametr_id: '248811', wartosc_id: '248811_100001' };
  for (const r of [await post(`${ADRES_KATEGORII}/regula`, regula, operator), await post(ADRES_MARKI, marka, operator)]) {
    expect(r.statusCode).toBe(403);
    expect(r.body).toContain('Tylko administrator');
  }
  expect(reguly()).toEqual(regulyPrzed);
  expect(marki()).toEqual([]);
  expect(klienci[CZYNNE].pobierzParametryKategorii).not.toHaveBeenCalled();
  expect((await post(`${ADRES_KATEGORII}/regula`, regula, admin)).statusCode).toBe(303);
  expect(reguly()).toEqual([...regulyPrzed, { parametr_id: '224017', potwierdzil: 'administrator-testowy' }]);
  expect((await post(ADRES_MARKI, marka, admin)).statusCode).toBe(303);
  expect(marki()).toEqual([{ marka: 'Pracownia Półcień', wartosc_id: '248811_100001' }]);
});

it('N6 (T2): formularze reguł parametrów i marki Allegro tylko na ekranie admina', async () => {
  expect((await post(ADRES_KATEGORII, { srodowisko: 'produkcja', kategoria_id: '257' }, admin)).statusCode).toBe(303);
  const formularzReguly = `action="${ADRES_KATEGORII}/regula"`;
  const formularzMarki = `<form method="post" action="${ADRES_MARKI}"`;
  expect((await get(`${ADRES_KATEGORII}?srodowisko=produkcja`, admin)).body).toContain(formularzReguly);
  expect((await get(`${ADRES_MARKI}?srodowisko=produkcja`, admin)).body).toContain(formularzMarki);
  const kategoria = await get(`${ADRES_KATEGORII}?srodowisko=produkcja`, operator);
  expect(kategoria.statusCode).toBe(200);
  expect(kategoria.body).not.toContain(formularzReguly);
  expect(kategoria.body).toContain('Stan');
  expect(kategoria.body).toContain('Reguły parametrów ustala administrator');
  const markaOp = await get(`${ADRES_MARKI}?srodowisko=produkcja`, operator);
  expect(markaOp.statusCode).toBe(200);
  expect(markaOp.body).not.toContain(formularzMarki);
  expect(markaOp.body).toContain('Markę w Allegro zatwierdza administrator');
});

// ——— N7 ———
it('N7: potwierdzenie wycofania wymienia konta ze wstrzymanymi ofertami albo w trybie tylko odczyt', async () => {
  oferta(CZYNNE, '7700000010', { stan: 'aktywna', odczytStatus: 'ACTIVE' });
  oferta(WSTRZYMANE, '7700000011', { stan: 'aktywna', odczytStatus: 'ACTIVE' });
  oferta(ODCZYT, '7700000012', { stan: 'aktywna', odczytStatus: 'ACTIVE' });
  const s = sekcjaSprzedazy((await get(`/magazyn/${kartaId}?wycofaj=tak`, admin)).body);
  expect(s).toContain('Oferty tej karty w kanałach zostaną zakończone przy najbliższym przebiegu. Wycofać?');
  expect(s).toMatch(OSTRZEZENIE);
  const zdanie = s.match(/<p[^>]*id="wycofanie-karty-wstrzymane"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '';
  expect(zdanie).toContain(WSTRZYMANE);
  expect(zdanie).toContain(ODCZYT);
  expect(zdanie).not.toContain(`${CZYNNE},`);
  expect(zdanie).not.toMatch(new RegExp(`${CZYNNE}(?!-)`));
  expect(s).toMatch(/aria-describedby="wycofanie-karty-opis wycofanie-karty-wstrzymane"/);
});

it('N7: przy czynnym koncie (i bez wejścia w potwierdzenie) ostrzeżenia nie ma', async () => {
  oferta(CZYNNE, '7700000010', { stan: 'aktywna', odczytStatus: 'ACTIVE' });
  expect(sekcjaSprzedazy((await get(`/magazyn/${kartaId}?wycofaj=tak`, admin)).body)).not.toMatch(OSTRZEZENIE);
  oferta(WSTRZYMANE, '7700000011', { stan: 'aktywna', odczytStatus: 'ACTIVE' });
  expect(sekcjaSprzedazy((await get(`/magazyn/${kartaId}`, admin)).body)).not.toMatch(OSTRZEZENIE);
  // Oferta już zakończona w Allegro nie ma czego kończyć — konto wstrzymane nie dostaje zdania.
  zapiszUstawieniaOfertKonta(db, WSTRZYMANE, { czynne: true });
  oferta(ODCZYT, '7700000012', { stan: 'nieaktywna', odczytStatus: 'ENDED' });
  expect(sekcjaSprzedazy((await get(`/magazyn/${kartaId}?wycofaj=tak`, admin)).body)).not.toMatch(OSTRZEZENIE);
});

it('N7 (T2): konto bez zgody na oferty też jest w ostrzeżeniu (pętla nie kończy tam ofert)', async () => {
  tokenKonta(CZYNNE, ['allegro:api:sale:offers:read']);
  oferta(CZYNNE, '7700000010', { stan: 'aktywna', odczytStatus: 'ACTIVE' });
  const s = sekcjaSprzedazy((await get(`/magazyn/${kartaId}?wycofaj=tak`, admin)).body);
  const zdanie = s.match(/<p[^>]*id="wycofanie-karty-wstrzymane"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '';
  expect(zdanie).toContain(CZYNNE);
  expect(zdanie).toContain('bez zgody');
});
