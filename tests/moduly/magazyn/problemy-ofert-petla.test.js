// Ekran → POST administratora → prawdziwa pętla na atrapach.
// Wzór środowiska: wznow-reczne-allegro.test.js.
// Atrapa ofert Allegro + prawdziwy rejestr kanałów i klient (środowisko jak w petla-ofert-allegro-pomiar.test.js).
// Żadnej sieci. Dane zmyślone: lampy „Pracownia Półcień”.
import { afterEach, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { ENV_DEMO } from '../../../scripts/demo-dane.mjs';
import { eanDemo, kategoriaAllegroDemo, parametryKategoriiAllegroDemo } from '../../../scripts/demo-dane-katalog.mjs';
import { opisKategorii } from '../../../src/domena/tresc-oferty-allegro.js';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import { zapiszUstawieniaOfertKonta, wstawOferte, ofertaPoId } from '../../../src/oms/db/oferty-kanalow.ts';
import { znakInstalacji } from '../../../src/moduly/magazyn/services/oferty-wspolne.js';
import { createAllegroClient } from '../../../src/oms/allegro/client.js';
import { katalogAllegro, wezlyAllegro } from '../../../src/integracje/kanal-modul.ts';
import { createSerwerOfertAllegro, API_ATRAPY_ALLEGRO } from '../../../deploy/proba/atrapy/allegro-oferty.mjs';
import { fixtureAllegro, daneAllegro, aktorAllegro } from '../../pomoc/allegro-konfigurator.ts';
import { szyfrTestowy } from '../../pomoc/sejf-testowy.ts';
import { createRejestrKanalow } from '../../../src/moduly/kanaly/services/rejestr-kanalow.ts';
import { createPetlaOfertAllegro } from '../../../src/moduly/magazyn/services/petla-ofert-allegro.js';

import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { createErliClient } from '../../../src/oms/erli/client.js';
import { katalogErli } from '../../../src/integracje/kanal-modul.ts';
import { createPetlaOfert } from '../../../src/moduly/magazyn/services/petla-ofert.js';

const T0 = Date.parse('2026-11-01T12:00:00.000Z');
const BEZPIECZENSTWO = JSON.stringify({ typ: 'TEXT', tekst: 'Nie zostawiaj włączonej lampy bez nadzoru.' });
const MIN = 60_000;

const sprzatanie = [];
const aplikacje = [];
afterEach(async () => {
  for (const app of aplikacje.splice(0)) await app.close();
  for (const f of sprzatanie.splice(0)) f();
});

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

/** Przebiegi co `krok` aż do stanu końcowego (najwyżej `n`). */
async function doKonca(e, p, ofertaId, { krok = 6000, n = 8 } = {}) {
  for (let i = 0; i < n && ['do_wyslania', 'wyslana', 'sprawdzana'].includes(ofertaPoId(e.db, ofertaId).stan); i++) {
    e.przesun(krok);
    await p.przebieg();
  }
  return ofertaPoId(e.db, ofertaId);
}


const PODGLAD = /^POST \/pricing\/offer-fee-preview$/;
const ZAPISY = /^(PUT|PATCH) /;
const cialaPo = (e, wzor, od = 0) => e.ciala.slice(od).filter((c) => wzor.test(c.zdarzenie));
const wznowienia = (e, od) => cialaPo(e, ZAPISY, od).filter((c) => c.cialo?.publication?.status === 'ACTIVE');
const przebieg = async (e, p, ms = MIN) => { e.przesun(ms); await p.przebieg(); };

async function wystawiona(e, opcje) {
  const k = karta(e.db, e.KONTO, opcje);
  const p = e.petla();
  const o = await doKonca(e, p, k.ofertaId);
  expect(o.stan).toBe('aktywna');
  return { ...k, p, o };
}
/** Oferta zakończona w Allegro przy `sztuk` sztukach (wyprzedana albo ręcznie). */
const zakoncz = (e, id, sztuk) => e.zmienWAtrapie(id, (x) => ({ ...x, stock: { ...x.stock, available: sztuk },
  publication: { ...x.publication, status: 'ENDED' } }));

const ERLI = 'erli-polcien';
const auth = { authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}`, origin: 'http://localhost' };

async function ekran(e, rodzaj = 'allegro') {
  const klucz = rodzaj === 'allegro' ? e.KONTO : ERLI;
  const konto = { klucz, nazwa: 'Półcień', autoryzacja: 'polaczone', srodowisko: 'produkcja' };
  const app = buildOmsServer({ db: e.db, config: { auth: { user: 'operator', pass: 'atrapa' },
    definicje: [{ klucz, typ: rodzaj, prefiks: 'TEST_POLCIEN', etykieta: 'Półcień' }] },
    magazyn: { stan: () => ({ trwa: false, kanaly: [] }) },
    nadpisania: { 'kanaly.klienciKanalow': { [klucz]: e.klient }, 'kanaly.repozytoriumKanalow': {
      listaTypu: typ => typ === rodzaj ? [konto] : [], zapisyZablokowane: () => false, konfliktKlucza: () => false,
    } },
  });
  aplikacje.push(app);
  await app.ready();
  if (rodzaj === 'allegro') {
    const scope = ['allegro:api:sale:offers:write', 'allegro:api:sale:settings:read'];
    const token = ['e30', Buffer.from(JSON.stringify({ scope })).toString('base64url'), 'podpis'].join('.');
    e.db.prepare(`INSERT INTO tokeny_kanalu (kanal, access_token, refresh_token, wygasa_at, zaktualizowane_at)
      VALUES (?, ?, ?, '2027-01-01T00:00:00Z', '2026-11-01T00:00:00Z')`).run(klucz,
      szyfrTestowy(e.db, 'tokeny_kanalu', 'access_token', klucz, token), szyfrTestowy(e.db, 'tokeny_kanalu', 'refresh_token', klucz, 'REFRESH-ATRAPA'));
  }
  return {
    lista: () => app.inject({ method: 'GET', url: '/magazyn/problemy-ofert', headers: auth }),
    post: (id, akcja, payload = {}) => app.inject({ method: 'POST', url: `/magazyn/problemy-ofert/${id}/${akcja}`, payload, headers: auth }),
  };
}
const wiersz = (r, id) => new RegExp(`<tr[^>]*id="oferta-${id}"[^>]*>([\\s\\S]*?)</tr>`).exec(r.body)?.[1];

it('Allegro: zakończona ręcznie (3 szt.) → ekran → Wznów → jeden PATCH ACTIVE z ilością → odczyt ACTIVE usuwa wiersz', async () => {
  const e = srodowisko();
  const { ofertaId, p, o } = await wystawiona(e);
  zakoncz(e, o.idZewnetrzne, 3);
  await przebieg(e, p);
  expect(ofertaPoId(e.db, ofertaId).problemy).toEqual([{ kod: 'zakonczona', sztuk: 3 }]);
  const web = await ekran(e);
  const r = await web.lista();
  expect(r.statusCode).toBe(200);
  expect(wiersz(r, ofertaId)).toContain(`/${ofertaId}/wznow`);
  expect(r.body).not.toContain('Prognoza opłaty');
  const przed = e.ciala.length;
  expect((await web.post(ofertaId, 'wznow')).statusCode).toBe(303);
  expect(ofertaPoId(e.db, ofertaId).wyslanePola.wznow).toEqual({ login: 'operator', at: expect.any(String) });
  expect(e.ciala).toHaveLength(przed);
  await przebieg(e, p);
  expect(cialaPo(e, /^PATCH /, przed).map(c => c.cialo)).toEqual([
    { stock: { available: 5 }, publication: { status: 'ACTIVE' } },
  ]);
  expect(cialaPo(e, PODGLAD, przed)).toEqual([]);
  expect(ofertaPoId(e.db, ofertaId).wyslanePola.wznow).toBeUndefined();
  expect((await doKonca(e, p, ofertaId)).odczytStatus).toBe('ACTIVE');
  expect(wiersz(await web.lista(), ofertaId)).toBeUndefined();
  await przebieg(e, p);
  expect(wznowienia(e, przed)).toHaveLength(1);
});

it('Allegro: cena ponad próg → ekran → Potwierdź cenę → jedna komenda z kwotą → wiersz znika', async () => {
  const e = srodowisko();
  const { ofertaId, kartaId, p, o } = await wystawiona(e);
  e.db.prepare('UPDATE karty_produktow SET cena_gr = 7670 WHERE id = ?').run(kartaId);
  const przed = e.ciala.length;
  await przebieg(e, p);
  expect(cialaPo(e, ZAPISY, przed)).toEqual([]);
  expect(ofertaPoId(e.db, ofertaId).cenaDoPotwierdzeniaGr).toBe(7670);
  const web = await ekran(e);
  const r = await web.lista();
  expect(r.statusCode).toBe(200);
  expect(wiersz(r, ofertaId)).toContain('Potwierdź cenę 76,70 zł');
  expect(wiersz(r, ofertaId)).toContain('name="cenaGr" value="7670"');
  expect((await web.post(ofertaId, 'potwierdz-cene', { cenaGr: '7670' })).statusCode).toBe(303);
  expect(cialaPo(e, ZAPISY, przed)).toEqual([]);
  await przebieg(e, p);
  const komendy = cialaPo(e, /^PUT \/sale\/offer-price-change-commands\//, przed);
  expect(komendy).toHaveLength(1);
  expect(komendy[0].cialo.modification).toEqual({ type: 'FIXED_PRICE', price: { amount: '76.70', currency: 'PLN' } });
  expect(e.ofertaWAtrapie(o.idZewnetrzne).sellingMode.price.amount).toBe('76.70');
  expect(ofertaPoId(e.db, ofertaId)).toMatchObject({ cenaDoPotwierdzeniaGr: null, problemy: [] });
  expect(wiersz(await web.lista(), ofertaId)).toBeUndefined();
});

// Atrapa fetch ERLI jak w petla-ofert.test.js; żadnej sieci.
function serwerErli() {
  const produkty = new Map();
  const zadania = [];
  const wymuszone = [];
  const odp = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status });
  async function fetchImpl(url, init) {
    const sciezka = new URL(url).pathname.replace(/^\/api/, '');
    const metoda = init.method;
    const surowe = typeof init.body === 'string' ? init.body : '';
    const cialo = surowe ? JSON.parse(surowe) : undefined;
    zadania.push({ metoda, sciezka, cialo, surowe });
    const i = wymuszone.findIndex(w => w.metoda === metoda && w.sciezka === sciezka);
    if (i >= 0) {
      const [w] = wymuszone.splice(i, 1);
      if (w.zawies) { w.zawies(); return new Promise(() => {}); }
      if (w.siec) throw new TypeError('fetch failed');
      return odp(w.status, w.body);
    }
    if (sciezka === '/products/_search' && metoda === 'POST') {
      const { limit = 100, after } = cialo?.pagination ?? {};
      const lista = [...produkty.values()].sort((a, b) => a.externalId.localeCompare(b.externalId))
        .filter(p => after === undefined || p.externalId > after);
      return odp(200, lista.slice(0, limit));
    }
    if (sciezka === '/products/batch-update' && metoda === 'PATCH') {
      return odp(200, cialo.map(z => {
        const p = produkty.get(z.externalId);
        if (!p) return { externalId: z.externalId, status: 400, polishMessage: 'Produkt nie istnieje' };
        produkty.set(z.externalId, { ...p, ...z });
        return { externalId: z.externalId, status: 202, updatedFields: Object.keys(z).filter(k => k !== 'externalId') };
      }).reverse());
    }
    const id = decodeURIComponent(sciezka.replace(/^\/products\//, ''));
    if (metoda === 'GET') return produkty.has(id) ? odp(200, produkty.get(id)) : odp(404, { message: 'Not found' });
    if (metoda === 'POST') {
      if (produkty.has(id)) return odp(409, [{ errorCode: '409', errorMessage: 'Product already exists' }]);
      produkty.set(id, { ...cialo, externalId: id, images: [], buyableProblems: ['shop-activity'] });
      return odp(202, { externalId: id, updatedFields: Object.keys(cialo) });
    }
    if (metoda === 'PATCH') {
      if (!produkty.has(id)) return odp(404, { message: 'Not found' });
      produkty.set(id, { ...produkty.get(id), ...cialo });
      return odp(202, { externalId: id, updatedFields: Object.keys(cialo) });
    }
    return odp(500, { message: 'nieobsłużone' });
  }
  const zapisy = () => zadania.filter(z => z.metoda !== 'GET' && z.sciezka !== '/products/_search');
  const wymus = w => wymuszone.push(w);
  return { produkty, zadania, zapisy, wymus, fetchImpl };
}

it('ERLI: cena +30% → ekran → Potwierdź cenę → PATCH price → wiersz znika', async () => {
  const db = openOmsDb(':memory:', { moduly: modulyDla(ENV_DEMO) });
  sprzatanie.push(() => db.close());
  const erli = serwerErli();
  const klient = createErliClient({ adresApi: 'https://polcien.example.invalid/api', kluczApi: 'fikcyjny', wersja: 'test',
    fetchImpl: erli.fetchImpl, czekaj: async () => {} });
  const kartaId = utworzKarte(db, { nazwa: 'Lampa Półcień', sku: 'LMP-01', cena_gr: 10000, stawka_vat: '23' });
  db.prepare(`INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, adres_zrodlowy, utworzono_at)
    VALUES (?, 0, 'woo', 'https://polcien.example.invalid/lampa.png', '2026-11-01T00:00:00Z')`).run(kartaId);
  zapiszUstawieniaOfertKonta(db, ERLI, { czynne: true, narzutProcent: 0, progPotwierdzeniaProcent: 20,
    stalaIlosc: 5, czasWysylkiDni: 2, cennikDostaw: 'Cennik Półcień', stawkaVat: '23' });
  const idZewnetrzne = `${znakInstalacji(db)}-K${kartaId}`;
  const o = wstawOferte(db, { kartaId, kanal: ERLI, idZewnetrzne, stan: 'do_wyslania', tryb: 'zarzadzana' });
  const p = createPetlaOfert({ db, teraz: () => new Date(T0), log: () => {},
    konta: () => [{ klucz: ERLI, katalog: katalogErli(klient), tylkoOdczyt: () => false }] });
  for (let i = 0; i < 8 && !['aktywna', 'nieaktywna'].includes(ofertaPoId(db, o.id).stan); i++) await p.przebieg();
  // ERLI przyjmuje nowy produkt jako szkic; aktywację i zakończenie pobierania zdjęć symuluje atrapa.
  erli.produkty.set(idZewnetrzne, { ...erli.produkty.get(idZewnetrzne), status: 'active', buyableProblems: [] });
  await p.przebieg();
  expect(ofertaPoId(db, o.id).stan).toBe('aktywna');
  erli.zadania.length = 0;
  db.prepare('UPDATE karty_produktow SET cena_gr = 13000 WHERE id = ?').run(kartaId);
  await p.przebieg();
  expect(ofertaPoId(db, o.id).cenaDoPotwierdzeniaGr).toBe(13000);
  expect(erli.zapisy()).toEqual([]);
  const web = await ekran({ db, klient }, 'erli');
  const r = await web.lista();
  expect(r.statusCode).toBe(200);
  expect(wiersz(r, o.id)).toContain('Potwierdź cenę 130,00 zł');
  expect(wiersz(r, o.id)).toContain('name="cenaGr" value="13000"');
  expect((await web.post(o.id, 'potwierdz-cene', { cenaGr: '13000' })).statusCode).toBe(303);
  expect(erli.zapisy()).toEqual([]);
  await p.przebieg();
  expect(erli.zapisy()).toEqual([expect.objectContaining({ metoda: 'PATCH', sciezka: '/products/batch-update',
    cialo: [{ externalId: idZewnetrzne, price: 13000 }] })]);
  expect(erli.produkty.get(idZewnetrzne).price).toBe(13000);
  expect(ofertaPoId(db, o.id)).toMatchObject({ cenaDoPotwierdzeniaGr: null, problemy: [] });
  expect(wiersz(await web.lista(), o.id)).toBeUndefined();
});
