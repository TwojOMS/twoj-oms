// PRZ-160 E4.23 — Wznów (D41) zakończonej oferty Allegro: liczba sztuk w problemie po nieudanym wznowieniu
// i bramka zapisu (Oferty: wstrzymane) przed i po `await trescKarty`.
// Szkielet środowiska: ponow-brak-w-allegro-prz160e4.test.js (atrapa ofert Allegro + prawdziwy rejestr i klient).
// Żadnej sieci. Dane zmyślone: lampy „Pracownia Półcień”.
import { readFileSync } from 'node:fs';
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

import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

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


const ZAPISY = /^(POST|PUT|PATCH) \/sale\//;
const NOWA_OFERTA = /^POST \/sale\/product-offers$/;
const przebieg = async (e, p, ms = MIN) => { e.przesun(ms); await p.przebieg(); };
const auth = { authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}`, origin: 'http://localhost' };
const pustaLista = (m, s) => (m === 'GET' && s === '/sale/offers'
  ? new Response(JSON.stringify({ offers: [], count: 0, totalCount: 0 }), { status: 200 }) : null);

async function ekran(e) {
  const konto = { klucz: e.KONTO, nazwa: 'Półcień', autoryzacja: 'polaczone', srodowisko: 'produkcja' };
  const app = buildOmsServer({ db: e.db, config: { auth: { user: 'operator', pass: 'atrapa' },
    definicje: [{ klucz: e.KONTO, typ: 'allegro', prefiks: 'TEST_POLCIEN', etykieta: 'Półcień' }] },
    magazyn: { stan: () => ({ trwa: false, kanaly: [] }) },
    nadpisania: { 'kanaly.klienciKanalow': { [e.KONTO]: e.klient }, 'kanaly.repozytoriumKanalow': {
      listaTypu: typ => typ === 'allegro' ? [konto] : [], zapisyZablokowane: () => false, konfliktKlucza: () => false,
    } },
  });
  aplikacje.push(app);
  await app.ready();
  const scope = ['allegro:api:sale:offers:write', 'allegro:api:sale:settings:read'];
  const token = ['e30', Buffer.from(JSON.stringify({ scope })).toString('base64url'), 'podpis'].join('.');
  e.db.prepare(`INSERT INTO tokeny_kanalu (kanal, access_token, refresh_token, wygasa_at, zaktualizowane_at)
    VALUES (?, ?, ?, '2027-01-01T00:00:00Z', '2026-11-01T00:00:00Z')`).run(e.KONTO,
    szyfrTestowy(e.db, 'tokeny_kanalu', 'access_token', e.KONTO, token), szyfrTestowy(e.db, 'tokeny_kanalu', 'refresh_token', e.KONTO, 'REFRESH-ATRAPA'));
  return {
    get: (url) => app.inject({ method: 'GET', url, headers: auth }),
    post: (url, payload = {}) => app.inject({ method: 'POST', url, payload, headers: auth }),
  };
}
const cialaPo = (e, od) => e.ciala.slice(od).filter((c) => /^(PUT|PATCH) /.test(c.zdarzenie));

const pomiar = (nazwa) => JSON.parse(readFileSync(new URL(`../../fixtures/allegro/${nazwa}`, import.meta.url), 'utf8'));
const P17 = pomiar('e3-pomiar-p17-publikacja-szkicu.json');
const odp = (status, cialo) => new Response(JSON.stringify(cialo), { status, headers: { 'Content-Type': 'application/json' } });
const OPERACJA = /^GET \/sale\/product-offers\/[^/]+\/operations\//;
const PRODUKTY = /^GET \/sale\/products$/;
const WZNOWIENIE = (c) => c.cialo?.publication?.status === 'ACTIVE';
/** Oferta zakończona w Allegro przy `sztuk` sztukach (wyprzedana albo ręcznie). */
const zakoncz = (e, id, sztuk) => e.zmienWAtrapie(id, (x) => ({ ...x, stock: { ...x.stock, available: sztuk },
  publication: { ...x.publication, status: 'ENDED' } }));
const wstrzymaj = (e) => zapiszUstawieniaOfertKonta(e.db, e.KONTO, { czynne: false }, { teraz: e.teraz().toISOString() });
const wznow = (e) => zapiszUstawieniaOfertKonta(e.db, e.KONTO, { czynne: true }, { teraz: e.teraz().toISOString() });

/** Aktywna oferta zakończona ręcznie przy 3 sztukach → problem „zakonczona” (sztuk 3) → operator wcisnął Wznów. */
async function zakonczonaPoWznow(e) {
  const { kartaId, ofertaId } = karta(e.db, e.KONTO);
  const p = e.petla();
  expect((await doKonca(e, p, ofertaId)).stan).toBe('aktywna');
  zakoncz(e, ofertaPoId(e.db, ofertaId).idZewnetrzne, 3);
  await przebieg(e, p);
  expect(ofertaPoId(e.db, ofertaId)).toMatchObject({ stan: 'problem', problemy: [{ kod: 'zakonczona', sztuk: 3 }] });
  const web = await ekran(e);
  expect((await web.post(`/magazyn/problemy-ofert/${ofertaId}/wznow`)).statusCode).toBe(303);
  expect(ofertaPoId(e.db, ofertaId).wyslanePola.wznow).toBeTruthy();
  return { kartaId, ofertaId, p };
}

describe('E4.23 — etap wznowienie nie gubi liczby sztuk', () => {
  it('operacja wznowienia kończy się 4xx → problem „zakonczona” z 3 sztukami (nie 0) i tekstem Allegro', async () => {
    const e = srodowisko();
    const { ofertaId, p } = await zakonczonaPoWznow(e);
    const przed = e.ciala.length;
    await przebieg(e, p);
    expect(ofertaPoId(e.db, ofertaId).stan).toBe('sprawdzana');
    e.st.awaria = (m, s) => (OPERACJA.test(`${m} ${s}`) ? odp(P17.ended_operacja.status, P17.ended_operacja.body) : null);
    const po = await doKonca(e, p, ofertaId);
    expect(po.problemy).toEqual([{ kod: 'zakonczona', sztuk: 3, tekst: expect.stringMatching(/odrzuciło wznowienie/) }]);
    expect(cialaPo(e, przed).filter(WZNOWIENIE)).toHaveLength(1);
  });

  it('Allegro przyjęło PATCH, a oferta dalej ENDED → problem „nie wznowiło” z 3 sztukami (nie 0)', async () => {
    const e = srodowisko();
    const { ofertaId, p } = await zakonczonaPoWznow(e);
    const o = ofertaPoId(e.db, ofertaId);
    await przebieg(e, p);
    expect(ofertaPoId(e.db, ofertaId).stan).toBe('sprawdzana');
    e.st.awaria = (m, s) => (OPERACJA.test(`${m} ${s}`)
      ? new Response(null, { status: 303, headers: { Location: `/sale/product-offers/${o.idZewnetrzne}` } }) : null);
    e.zmienWAtrapie(o.idZewnetrzne, (x) => ({ ...x, publication: { ...x.publication, status: 'ENDED' } }));
    const po = await doKonca(e, p, ofertaId);
    expect(po.problemy).toEqual([{ kod: 'zakonczona', sztuk: 3, tekst: expect.stringContaining('ENDED') }]);
  });
});

describe('E4.23 — Wznów a bramka zapisu (Oferty: wstrzymane)', () => {
  it('Wznów przy wstrzymanych ofertach konta → żadnego żądania wznowienia; po włączeniu jeden PATCH', async () => {
    const e = srodowisko();
    const { ofertaId, p } = await zakonczonaPoWznow(e);
    wstrzymaj(e);
    const przed = e.zdarzenia.length;
    const cialPrzed = e.ciala.length;
    for (let i = 0; i < 3; i++) await przebieg(e, p, 20 * MIN);
    const po = e.zdarzenia.slice(przed);
    expect(po.filter((z) => ZAPISY.test(z) || PRODUKTY.test(z) || OPERACJA.test(z))).toEqual([]);
    expect(ofertaPoId(e.db, ofertaId)).toMatchObject({ stan: 'problem', problemy: [{ kod: 'zakonczona', sztuk: 3 }] });
    expect(ofertaPoId(e.db, ofertaId).wyslanePola.wznow).toBeTruthy();
    wznow(e);
    await przebieg(e, p);
    expect(cialaPo(e, cialPrzed).filter(WZNOWIENIE)).toHaveLength(1);
  });

  it('bramka zamknięta w trakcie `await trescKarty` przy Wznów → po powrocie bez PATCH', async () => {
    const e = srodowisko();
    const { ofertaId, p } = await zakonczonaPoWznow(e);
    // Wiersz bez produktu z katalogu (droga przez EAN) — wznowienie pyta Allegro o produkt (`trescKarty`).
    const { produktId: _bez, ...pola } = ofertaPoId(e.db, ofertaId).wyslanePola;
    zmienOferte(e.db, ofertaId, { wyslanePola: { ...pola, droga: 'ean' } });
    e.st.awaria = (m, s) => { if (PRODUKTY.test(`${m} ${s}`)) wstrzymaj(e); return null; };
    const przed = e.zdarzenia.length;
    await przebieg(e, p);
    const po = e.zdarzenia.slice(przed);
    expect(po.filter((z) => PRODUKTY.test(z))).toHaveLength(1);
    expect(po.filter((z) => ZAPISY.test(z))).toEqual([]);
    expect(ofertaPoId(e.db, ofertaId).wyslanePola.wznow).toBeTruthy();
  });

  it('Wznów przy wstrzymanych ofertach, wiersz bez produktu z katalogu → nawet bez pytania Allegro o produkt', async () => {
    const e = srodowisko();
    const { ofertaId, p } = await zakonczonaPoWznow(e);
    const { produktId: _bez, ...pola } = ofertaPoId(e.db, ofertaId).wyslanePola;
    zmienOferte(e.db, ofertaId, { wyslanePola: { ...pola, droga: 'ean' } });
    wstrzymaj(e);
    const przed = e.zdarzenia.length;
    await przebieg(e, p, 20 * MIN);
    expect(e.zdarzenia.slice(przed).filter((z) => ZAPISY.test(z) || PRODUKTY.test(z) || OPERACJA.test(z))).toEqual([]);
    expect(ofertaPoId(e.db, ofertaId).wyslanePola.wznow).toBeTruthy();
  });

  it('bramka zamknięta w trakcie odczytu ofert (konto czynne na starcie przebiegu) → Wznów bez żadnego zapytania', async () => {
    const e = srodowisko();
    const { ofertaId, p } = await zakonczonaPoWznow(e);
    const { produktId: _bez, ...pola } = ofertaPoId(e.db, ofertaId).wyslanePola;
    zmienOferte(e.db, ofertaId, { wyslanePola: { ...pola, droga: 'ean' } });
    e.st.awaria = (m, s) => { if (m === 'GET' && !PRODUKTY.test(`${m} ${s}`)) wstrzymaj(e); return null; };
    const przed = e.zdarzenia.length;
    await przebieg(e, p, 20 * MIN);
    const po = e.zdarzenia.slice(przed);
    expect(po.length).toBeGreaterThan(0);
    expect(po.filter((z) => ZAPISY.test(z) || PRODUKTY.test(z) || OPERACJA.test(z))).toEqual([]);
    expect(ofertaPoId(e.db, ofertaId).wyslanePola.wznow).toBeTruthy();
  });

  it('bramka zamknięta w trakcie wgrywania ostatniego zdjęcia przy wystawianiu → bez POST oferty', async () => {
    const e = srodowisko();
    const { ofertaId } = karta(e.db, e.KONTO, { n: 1 });
    const p = e.petla();
    const ZDJECIE = /^POST \/sale\/images$/;
    e.st.awaria = (m, s) => { if (ZDJECIE.test(`${m} ${s}`)) wstrzymaj(e); return null; };
    await przebieg(e, p);
    expect(e.zdarzenia.filter((z) => ZDJECIE.test(z))).toHaveLength(1);
    expect(e.zdarzenia.filter((z) => !ZDJECIE.test(z) && ZAPISY.test(z))).toEqual([]);
    expect(ofertaPoId(e.db, ofertaId).stan).toBe('do_wyslania');
  });

  it('bramka zamknięta w trakcie `await trescKarty` przy wystawianiu → po powrocie bez POST oferty', async () => {
    const e = srodowisko();
    const { ofertaId } = karta(e.db, e.KONTO);
    const p = e.petla();
    e.st.awaria = (m, s) => { if (PRODUKTY.test(`${m} ${s}`)) wstrzymaj(e); return null; };
    await przebieg(e, p);
    expect(e.zdarzenia.filter((z) => PRODUKTY.test(z))).toHaveLength(1);
    expect(e.zdarzenia.filter((z) => NOWA_OFERTA.test(z) || ZAPISY.test(z))).toEqual([]);
    expect(ofertaPoId(e.db, ofertaId).stan).toBe('do_wyslania');
  });
});
