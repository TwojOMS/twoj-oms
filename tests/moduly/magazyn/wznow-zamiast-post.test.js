// Istniejący numer Allegro wraca do synchronizacji; zakończona oferta tylko przez Wznów.
// Środowisko z wznow-reczne-allegro.test.js: atrapa + prawdziwy rejestr kanałów i klient.
// Żadnej sieci. Dane zmyślone: lampy „Pracownia Półcień”.
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { ENV_DEMO } from '../../../scripts/demo-dane.mjs';
import { eanDemo, kategoriaAllegroDemo, parametryKategoriiAllegroDemo } from '../../../scripts/demo-dane-katalog.mjs';
import { opisKategorii } from '../../../src/domena/tresc-oferty-allegro.js';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import { zapiszUstawieniaOfertKonta, wstawOferte, ofertaPoId, zmienOferte } from '../../../src/oms/db/oferty-kanalow.ts';
import { znakInstalacji } from '../../../src/moduly/magazyn/services/oferty-wspolne.js';
import { createAllegroClient } from '../../../src/oms/allegro/client.js';
import { katalogAllegro, wezlyAllegro } from '../../../src/integracje/kanal-modul.ts';
import { createSerwerOfertAllegro, API_ATRAPY_ALLEGRO } from '../../../deploy/proba/atrapy/allegro-oferty.mjs';
import { fixtureAllegro, daneAllegro, aktorAllegro } from '../../pomoc/allegro-konfigurator.ts';
import { szyfrTestowy } from '../../pomoc/sejf-testowy.ts';
import { createRejestrKanalow } from '../../../src/moduly/kanaly/services/rejestr-kanalow.ts';
import { createPetlaOfertAllegro } from '../../../src/moduly/magazyn/services/petla-ofert-allegro.js';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';

const T0 = Date.parse('2026-11-01T12:00:00.000Z');
const BEZPIECZENSTWO = JSON.stringify({ typ: 'TEXT', tekst: 'Nie zostawiaj włączonej lampy bez nadzoru.' });
const MIN = 60_000;

const sprzatanie = [];
afterEach(() => { for (const f of sprzatanie.splice(0)) f(); });

const zawies = (signal) => new Promise((_r, reject) => {
  if (signal?.aborted) { reject(signal.reason); return; }
  signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
});

/** Karta z kategorią z mapy, regułami, marką, GPSR konta, `n` zdjęciami i EAN demo (D34 → katalog-id). */
function karta(db, konto, { nazwa = 'Lampa stołowa Gliwka z kloszem', n = 2 } = {}) {
  const id = utworzKarte(db, { nazwa, cena_gr: 5900, stawka_vat: '23', marka: 'Pracownia Półcień',
    kategoria_glowna: 'Lampy stołowe', szerokosc_mm: 255,
    opis_sekcje_json: JSON.stringify({ sekcje: [{ elementy: [{ typ: 'tekst', html: '<p>Lampa z mlecznym kloszem.</p>' }] }] }) },
  { at: new Date(T0).toISOString() });
  db.prepare('UPDATE karty_produktow SET informacja_bezpieczenstwa = ?, ean = ? WHERE id = ?').run(BEZPIECZENSTWO, eanDemo(1), id);
  const zdj = db.prepare(`INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, adres_zrodlowy, sha256, typ, ai, ai_reczne, utworzono_at)
    VALUES (?, ?, 'reczne', ?, NULL, 'image/jpeg', 0, 1, ?)`);
  for (let i = 0; i < n; i++) zdj.run(id, i, `https://polcien.example.invalid/gliwka-${id}-${i + 1}.jpg`, new Date(T0).toISOString());
  // Opis kategorii 257 (wersja 2) w pamięci konta — ten sam zapis, co `opisKategoriiAllegro` po pobraniu.
  const opis = opisKategorii(['5', '256', '257'].map(kategoriaAllegroDemo), parametryKategoriiAllegroDemo('257'));
  db.prepare(`INSERT OR IGNORE INTO kanaly_kategorie (polaczenie, kategoria_id, sciezka_json, parametry_json, pobrano_at) VALUES (?, '257', ?, ?, ?)`)
    .run(konto, JSON.stringify(opis.sciezka), JSON.stringify({ wersja: opis.wersja, lisc: opis.lisc, tworzenieProduktu: opis.tworzenieProduktu, parametry: opis.parametry }), new Date(T0).toISOString());
  db.prepare(`INSERT OR IGNORE INTO allegro_mapa_kategorii (kategoria_karty, srodowisko, kategoria_allegro_id) VALUES ('Lampy stołowe', 'produkcja', '257')`).run();
  const regula = db.prepare(`INSERT OR IGNORE INTO allegro_reguly_parametrow (srodowisko, kategoria_allegro_id, parametr_id, rodzaj,
    wartosc_json, pole, zmieniono_at) VALUES ('produkcja', '257', ?, ?, ?, ?, ?)`);
  regula.run('11323', 'stala', JSON.stringify({ valuesIds: ['11323_1'] }), null, new Date(T0).toISOString());
  regula.run('248811', 'pole', null, 'marka', new Date(T0).toISOString());
  db.prepare(`INSERT OR IGNORE INTO allegro_marki (marka, srodowisko, parametr_id, wartosc_id, kategorie_sprawdzone_json, zmieniono_at)
    VALUES ('Pracownia Półcień', 'produkcja', '248811', '248811_9001', '["257"]', ?)`).run(new Date(T0).toISOString());
  db.prepare(`INSERT OR IGNORE INTO allegro_marki_gpsr (marka, konto, zrodlo, zmieniono_at) VALUES ('Pracownia Półcień', ?, 'konto', ?)`)
    .run(konto, new Date(T0).toISOString());
  const wiersz = wstawOferte(db, { kartaId: id, kanal: konto, idZewnetrzne: `ext:${znakInstalacji(db)}-K${id}`, tryb: 'zarzadzana', stan: 'do_wyslania' },
    { teraz: new Date(T0).toISOString() });
  return { kartaId: id, ofertaId: wiersz.id };
}

/** Atrapa + prawdziwy rejestr kanałów + prawdziwy klient + baza OMS. `awaria(metoda, sciezka)` wstrzykuje usterki. */
function srodowisko({ ustawienia = {}, zgoda = true, tylkoOdczyt = () => false } = {}) {
  let czas = T0;
  const teraz = () => new Date(czas);
  const f = fixtureAllegro();
  const s = f.szkic();
  const k = daneAllegro(f.repo.zapiszZmiane(s.klucz, s.wersja, { autoryzacja: 'polaczone', kontoId: '123' }, aktorAllegro));
  const KONTO = k.klucz;
  const dbAtrapy = new DatabaseSync(':memory:');
  const serwer = createSerwerOfertAllegro({ db: dbAtrapy, kanal: KONTO, env: ENV_DEMO, teraz });
  const zdarzenia = [];
  const ciala = [];
  const st = { awaria: null };
  async function fetchImpl(url, init = {}) {
    const metoda = String(init.method ?? 'GET').toUpperCase();
    const adres = new URL(url);
    const sciezka = adres.pathname;
    zdarzenia.push(`${metoda} ${sciezka}`);
    if (typeof init.body === 'string') {
      try { ciala.push({ zdarzenie: `${metoda} ${sciezka}`, cialo: JSON.parse(init.body) }); } catch { /* ciało nie-JSON */ }
    }
    const a = st.awaria?.(metoda, sciezka, adres);
    if (a === 'zgubiona-odpowiedz') { await serwer.fetchImpl(url, init); return zawies(init.signal); }
    if (a === 'bez-dotarcia') return zawies(init.signal);
    if (a instanceof Response) return a;
    return serwer.fetchImpl(url, init);
  }
  const rejestr = createRejestrKanalow({ repozytorium: f.repo, fetchImpl, limitCzasuMs: 200, teraz,
    fabryki: ({ http }) => ({
      klient: createAllegroClient({ ustawienia: { api: API_ATRAPY_ALLEGRO, userAgent: 'test/1 (+https://x.invalid)' },
        tokeny: { waznyToken: async () => 'token-atrapy-e308a' }, http }),
      poller: { stan: () => null, przebieg: async () => {} },
    }) });
  const klient = rejestr.klient(KONTO);
  const db = openOmsDb(':memory:', { moduly: modulyDla(ENV_DEMO) });
  sprzatanie.push(() => { db.close(); dbAtrapy.close(); f.db.close(); });
  zapiszUstawieniaOfertKonta(db, KONTO, { czynne: true, aktywujPoSprawdzeniu: true, narzutProcent: 0, stalaIlosc: 5,
    czasWysylkiDni: 2, cennikDostaw: 'cennik-1', stawkaVat: '23', zwrotyId: 'zwrot-1', reklamacjeId: 'rekl-1',
    producentId: 'prod-konta', ...ustawienia }, { teraz: new Date(T0).toISOString() });
  const konto = { klucz: KONTO, nazwa: 'Półcień Allegro', srodowisko: 'produkcja', zgoda, tylkoOdczyt,
    katalog: katalogAllegro(klient), allegro: wezlyAllegro(klient) };
  const petla = () => createPetlaOfertAllegro({ db, konta: () => [konto], teraz,
    zwolnijOperacje: (klucz, metoda, zasob) => f.repo.zwolnijOperacje(klucz, metoda, zasob),
    czytajZdjecie: async (z) => new Uint8Array([7, z.id, z.kolejnosc + 1]) });
  const przesun = (ms) => { czas += ms; f.setCzas(new Date(czas).toISOString()); };
  const ile = (wzor) => zdarzenia.filter((z) => wzor.test(z)).length;
  const ofertyAtrapy = (ext) => dbAtrapy.prepare('SELECT dane_json FROM atrapa_allegro_oferty WHERE kanal = ?').all(KONTO)
    .map((w) => JSON.parse(w.dane_json)).filter((o) => o.external?.id === ext);
  const wstawDoAtrapy = (o) => dbAtrapy.prepare('INSERT INTO atrapa_allegro_oferty (kanal, id, dane_json) VALUES (?, ?, ?)')
    .run(KONTO, String(o.id), JSON.stringify(o));
  const ofertaWAtrapie = (id) => JSON.parse(dbAtrapy.prepare('SELECT dane_json FROM atrapa_allegro_oferty WHERE kanal = ? AND id = ?')
    .get(KONTO, String(id)).dane_json);
  const zmienWAtrapie = (id, f) => dbAtrapy.prepare('UPDATE atrapa_allegro_oferty SET dane_json = ? WHERE kanal = ? AND id = ?')
    .run(JSON.stringify(f(ofertaWAtrapie(id))), KONTO, String(id));
  return { db, f, klient, KONTO, st, zdarzenia, ciala, petla, przesun, ile, ofertyAtrapy, wstawDoAtrapy, ofertaWAtrapie, zmienWAtrapie, teraz, konto };
}

const aplikacje = [];
afterEach(async () => { for (const app of aplikacje.splice(0)) await app.close(); });
const auth = { authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}`, origin: 'http://localhost' };
async function ekran(e) {
  const app = buildOmsServer({ db: e.db, config: { auth: { user: 'operator', pass: 'atrapa' },
    definicje: [{ klucz: e.KONTO, typ: 'allegro', prefiks: 'TEST_POLCIEN', etykieta: 'Półcień' }] },
    magazyn: { stan: () => ({ trwa: false, kanaly: [] }) },
    nadpisania: { 'kanaly.klienciKanalow': { [e.KONTO]: e.klient }, 'kanaly.repozytoriumKanalow': {
      listaTypu: typ => typ === 'allegro' ? [{ ...e.konto, autoryzacja: 'polaczone' }] : [],
      zapisyZablokowane: () => false, konfliktKlucza: () => false,
    } },
  });
  aplikacje.push(app);
  await app.ready();
  const scope = ['allegro:api:sale:offers:write', 'allegro:api:sale:settings:read'];
  const token = ['e30', Buffer.from(JSON.stringify({ scope })).toString('base64url'), 'podpis'].join('.');
  e.db.prepare(`INSERT INTO tokeny_kanalu (kanal, access_token, refresh_token, wygasa_at, zaktualizowane_at)
    VALUES (?, ?, ?, '2027-01-01T00:00:00Z', '2026-11-01T00:00:00Z')`).run(e.KONTO,
    szyfrTestowy(e.db, 'tokeny_kanalu', 'access_token', e.KONTO, token), szyfrTestowy(e.db, 'tokeny_kanalu', 'refresh_token', e.KONTO, 'REFRESH-ATRAPA'));
  return { post: (url, payload = {}) => app.inject({ method: 'POST', url, payload, headers: auth }),
    get: url => app.inject({ url, headers: auth }) };
}
const POST = /^POST \/sale\/product-offers$/;
const PATCH = /^PATCH \/sale\/product-offers\/7700000001$/;
function zakonczona(e, zmiany = {}) {
  const k = karta(e.db, e.KONTO);
  e.db.prepare('UPDATE oferty_kanalow SET id_zewnetrzne = ? WHERE id = ?').run('7700000001', k.ofertaId);
  zmienOferte(e.db, k.ofertaId, { odczytStatus: 'ENDED', odczytIlosc: 3, ...zmiany });
  e.wstawDoAtrapy({ id: '7700000001', name: 'Lampa Gliwka', stock: { available: 3 },
    publication: { status: 'ENDED' }, sellingMode: { price: { amount: '59.00', currency: 'PLN' } } });
  return k;
}
async function przebieg(e) { e.przesun(MIN); await e.petla().przebieg(); }

describe('numer Allegro nigdy nie wraca do POST', () => {
  it('do_wyslania z numerem → zakończona, admin Wznów → jeden PATCH pod tym samym numerem', async () => {
    const e = srodowisko({ ustawienia: { stalaIlosc: 3 } });
    const k = zakonczona(e);
    const a = await ekran(e);
    await przebieg(e);
    expect(e.ile(POST)).toBe(0);
    expect(ofertaPoId(e.db, k.ofertaId)).toMatchObject({ idZewnetrzne: '7700000001', stan: 'problem', problemy: [{ kod: 'zakonczona', sztuk: 3 }] });
    const widok = await a.get(`/magazyn/${k.kartaId}`);
    expect(widok.statusCode).toBe(200);
    expect(widok.body).toContain(`action="/magazyn/problemy-ofert/${k.ofertaId}/wznow"`);
    expect((await a.post(`/magazyn/${k.kartaId}/oferty/${k.ofertaId}/ponow`)).statusCode).toBe(409);
    expect((await a.post(`/magazyn/problemy-ofert/${k.ofertaId}/wznow`)).statusCode).toBe(303);
    await przebieg(e);
    expect(e.ile(POST)).toBe(0);
    expect(e.ciala.filter(c => PATCH.test(c.zdarzenie)).map(c => c.cialo)).toEqual([
      { stock: { available: 3 }, publication: { status: 'ACTIVE' } },
    ]);
    expect(e.ile(/^POST \/pricing\/offer-fee-preview$/)).toBe(0);
  });
  it('numer bez odczytu + Allegro ENDED wyprzedana → tylko Wznów z ilością, bez gołego ACTIVE', async () => {
    const e = srodowisko({ ustawienia: { stalaIlosc: 3 } });
    const k = karta(e.db, e.KONTO);
    e.db.prepare('UPDATE oferty_kanalow SET id_zewnetrzne = ? WHERE id = ?').run('7700000001', k.ofertaId);
    e.wstawDoAtrapy({ id: '7700000001', name: 'Lampa Gliwka', stock: { available: 0 },
      publication: { status: 'ENDED' }, sellingMode: { price: { amount: '59.00', currency: 'PLN' } } });
    for (let i = 0; i < 4; i++) await przebieg(e);
    expect(e.ile(POST)).toBe(0);
    // Wyprzedana (0 szt.) → samoczynne Wznów D41 z ilością z karty; nigdy goły PATCH ACTIVE.
    const ciala = e.ciala.filter(c => PATCH.test(c.zdarzenie)).map(c => c.cialo);
    expect(ciala.filter(c => c.publication)).toEqual([{ stock: { available: 3 }, publication: { status: 'ACTIVE' } }]);
  });
  it('numer bez odczytu + Allegro ENDED z ilością → problem zakonczona do Wznów, 0 PATCH', async () => {
    const e = srodowisko({ ustawienia: { stalaIlosc: 3 } });
    const k = karta(e.db, e.KONTO);
    e.db.prepare('UPDATE oferty_kanalow SET id_zewnetrzne = ? WHERE id = ?').run('7700000001', k.ofertaId);
    e.wstawDoAtrapy({ id: '7700000001', name: 'Lampa Gliwka', stock: { available: 2 },
      publication: { status: 'ENDED' }, sellingMode: { price: { amount: '59.00', currency: 'PLN' } } });
    for (let i = 0; i < 4; i++) await przebieg(e);
    expect(e.ile(POST)).toBe(0);
    expect(e.ile(PATCH)).toBe(0);
    expect(ofertaPoId(e.db, k.ofertaId)).toMatchObject({ stan: 'problem', odczytStatus: 'ENDED', problemy: [{ kod: 'zakonczona', sztuk: 2 }] });
  });
  it('wybór produktu z numerem: odmowa 409 bez zapisu, bez POST', async () => {
    const e = srodowisko();
    const k = zakonczona(e, { stan: 'problem', problemy: [{ kod: 'wiele-produktow', produkty: [{ id: 'prod-2', nazwa: 'Lampa' }] }] });
    const a = await ekran(e);
    const przed = ofertaPoId(e.db, k.ofertaId);
    const odp = await a.post(`/magazyn/${k.kartaId}/allegro/produkt`, { ofertaId: String(k.ofertaId), produktId: 'prod-2' });
    expect(odp.statusCode).toBe(409);
    expect(odp.body).toContain('7700000001');
    expect(ofertaPoId(e.db, k.ofertaId)).toEqual(przed);
    await przebieg(e);
    expect(e.ile(POST)).toBe(0);
  });
  it('Aktywuj odmawia dla ENDED, także zaległa flaga nie wysyła gołego ACTIVE', async () => {
    const e = srodowisko();
    const k = zakonczona(e, { stan: 'nieaktywna', wyslanePola: { szkic: true } });
    const a = await ekran(e);
    expect((await a.post(`/magazyn/${k.kartaId}/oferty/${k.ofertaId}/aktywuj`)).statusCode).toBe(409);
    zmienOferte(e.db, k.ofertaId, { wyslanePola: { szkic: true, aktywuj: true } });
    await przebieg(e);
    expect(e.ile(POST)).toBe(0);
    expect(e.ile(PATCH)).toBe(0);
    expect(ofertaPoId(e.db, k.ofertaId).wyslanePola.aktywuj).toBeUndefined();
  });
  it('ext nadal wystawia nową ofertę jednym POST', async () => {
    const e = srodowisko();
    karta(e.db, e.KONTO);
    await przebieg(e);
    expect(e.ile(POST)).toBe(1);
  });
});

