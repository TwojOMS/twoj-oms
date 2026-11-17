// Rezerwa komend oraz przerwa i etap po odczycie „nadal ACTIVE”.
// Środowisko testowe skopiowane z petla-ofert-allegro-pomiar.test.js (atrapa API Allegro w procesie).
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
import { createRejestrKanalow } from '../../../src/moduly/kanaly/services/rejestr-kanalow.ts';
import { createPetlaOfertAllegro, LIMIT_ZAPISOW_PRZEBIEGU, REZERWA_KOMEND_PRZEBIEGU } from '../../../src/moduly/magazyn/services/petla-ofert-allegro.js';

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
  return { db, f, KONTO, st, zdarzenia, ciala, petla, przesun, ile, ofertyAtrapy, wstawDoAtrapy, ofertaWAtrapie, zmienWAtrapie, teraz, konto };
}

const POST = /^POST \/sale\/product-offers$/;

/** Przebiegi co `krok` aż do stanu końcowego (najwyżej `n`). */
async function doKonca(e, p, ofertaId, { krok = 6000, n = 8 } = {}) {
  for (let i = 0; i < n && ['do_wyslania', 'wyslana', 'sprawdzana'].includes(ofertaPoId(e.db, ofertaId).stan); i++) {
    e.przesun(krok);
    await p.przebieg();
  }
  return ofertaPoId(e.db, ofertaId);
}

const PATCH = /^PATCH \/sale\/product-offers\//;
const PUT_ILOSCI = /^PUT \/sale\/offer-quantity-change-commands\//;
const zapisyOd = (e, od) => e.ciala.slice(od).filter((c) => /^(PATCH|PUT) /.test(c.zdarzenie));

async function wystawiona(e) {
  const k = karta(e.db, e.KONTO);
  const p = e.petla();
  const o = await doKonca(e, p, k.ofertaId);
  expect(o.stan).toBe('aktywna');
  return { ...k, p, o };
}

describe('E3.33 — rezerwa zapisów i odczyt „nadal ACTIVE”', () => {
  it('nadmiar PATCH czeka bez błędu, a komenda ilości korzysta z rezerwy w tym samym przebiegu', async () => {
    const e = srodowisko();
    const { ofertaId, o, p } = await wystawiona(e);
    e.zmienWAtrapie(o.idZewnetrzne, (x) => ({ ...x, stock: { ...x.stock, available: 3 } }));
    const wzor = e.ofertaWAtrapie(o.idZewnetrzne);
    const doZdjecia = [];
    const at = e.teraz().toISOString();
    for (let i = 0; i < LIMIT_ZAPISOW_PRZEBIEGU + 5; i++) {
      const kartaId = utworzKarte(e.db, { nazwa: `Kinkiet testowy nr ${i}`, cena_gr: 5900, stawka_vat: '23' }, { at });
      e.db.prepare('UPDATE karty_produktow SET wycofana = 1 WHERE id = ?').run(kartaId);
      const id = String(9_300_000 + i);
      e.wstawDoAtrapy({ ...wzor, id, stock: { ...wzor.stock, available: 5 }, external: { id: `${znakInstalacji(e.db)}-K${kartaId}` } });
      doZdjecia.push(wstawOferte(e.db, { kartaId, kanal: e.KONTO, idZewnetrzne: id, tryb: 'zarzadzana', stan: 'aktywna' }, { teraz: at }));
    }

    const przed = e.ciala.length;
    e.przesun(MIN);
    await p.przebieg();
    const zapisy = zapisyOd(e, przed);
    const patche = zapisy.filter((c) => PATCH.test(c.zdarzenie));
    const komendy = zapisy.filter((c) => PUT_ILOSCI.test(c.zdarzenie));
    const naPatch = LIMIT_ZAPISOW_PRZEBIEGU - REZERWA_KOMEND_PRZEBIEGU;
    expect(patche).toHaveLength(naPatch);
    expect(patche.every((c) => c.cialo.publication?.status === 'ENDED')).toBe(true);
    expect(komendy).toHaveLength(1);
    expect(zapisy).toHaveLength(naPatch + 1);
    expect(zapisy.length).toBeLessThanOrEqual(LIMIT_ZAPISOW_PRZEBIEGU);
    // Komenda idzie po PATCH-ach: korzysta z puli powyżej progu PATCH.
    expect(PUT_ILOSCI.test(zapisy.at(-1).zdarzenie)).toBe(true);
    expect(e.ofertaWAtrapie(o.idZewnetrzne).stock.available).toBe(5);
    expect(ofertaPoId(e.db, ofertaId).wyslanaIlosc).toBe(5);
    for (const w of doZdjecia.slice(0, naPatch)) expect(ofertaPoId(e.db, w.id).stan).toBe('sprawdzana');
    const czekajace = doZdjecia.slice(naPatch);
    expect(czekajace.length).toBeGreaterThan(0);
    for (const w of czekajace) {
      expect(ofertaPoId(e.db, w.id)).toMatchObject({ stan: w.stan, wyslanePola: w.wyslanePola,
        blad: null, problemy: [], liczbaProb: 0, nastepnaProbaAt: null });
      expect(ofertaPoId(e.db, w.id).wyslanePola).toEqual(w.wyslanePola);
      expect(e.ofertaWAtrapie(w.idZewnetrzne).publication.status).toBe('ACTIVE');
    }
    const przed2 = e.ciala.length;
    e.przesun(MIN);
    await p.przebieg();
    expect(zapisyOd(e, przed2).filter((c) => PATCH.test(c.zdarzenie))).toHaveLength(czekajace.length);
  });

  it('zakończenie bez zmiany ACTIVE zeruje etap i ponawia PATCH dopiero po przerwie 5, potem 10 minut', async () => {
    const e = srodowisko();
    const { ofertaId, kartaId, o, p } = await wystawiona(e);
    e.db.prepare('UPDATE karty_produktow SET wycofana = 1 WHERE id = ?').run(kartaId);
    // Allegro przyjmuje PATCH, ale odczyt nadal pokazuje ACTIVE (bez błędu HTTP i operacji 422).
    e.st.awaria = (m, s) => m === 'PATCH' && s === `/sale/product-offers/${o.idZewnetrzne}`
      ? new Response(JSON.stringify(e.ofertaWAtrapie(o.idZewnetrzne)), { status: 200, headers: { 'Content-Type': 'application/json' } }) : null;
    const przed = e.ciala.length;
    await p.przebieg();
    for (let n = 1; n <= 2; n++) {
      expect(ofertaPoId(e.db, ofertaId)).toMatchObject({ stan: 'sprawdzana', wyslanePola: { etap: 'zdejmowanie' } });
      e.przesun(5000);
      await p.przebieg();
      const w = ofertaPoId(e.db, ofertaId);
      expect(w).toMatchObject({ stan: 'aktywna', odczytStatus: 'ACTIVE', blad: 'oferta nadal ACTIVE',
        problemy: [], wyslanePola: { probyZdjecia: n, etap: null, operacja: null } });
      expect(w.wyslanePola.etap).toBeNull();
      expect(w.wyslanePola.wycofanoAt).toBeUndefined();
      expect(Date.parse(w.nastepnaProbaAt) - e.teraz().getTime()).toBe(5 * MIN * 2 ** (n - 1));
      expect(zapisyOd(e, przed)).toHaveLength(n);
      // Nowa instancja pętli respektuje przerwę utrwaloną w bazie, także 1 ms przed terminem.
      const kolejna = e.petla();
      await kolejna.przebieg();
      e.przesun(5 * MIN * 2 ** (n - 1) - 1);
      await kolejna.przebieg();
      expect(zapisyOd(e, przed)).toHaveLength(n);
      expect(ofertaPoId(e.db, ofertaId).wyslanePola.etap).toBeNull();
      e.przesun(1);
      await kolejna.przebieg();
      expect(zapisyOd(e, przed)).toHaveLength(n + 1);
      expect(e.ofertaWAtrapie(o.idZewnetrzne).publication.status).toBe('ACTIVE');
    }
  });
});
