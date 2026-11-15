// PRZ-160 E3d.02-04 — skrót dostawy, minimalny PATCH i przejście dawnego skrótu.
// Allegro: atrapa E3.15 przez prawdziwy rejestr i klienta; ERLI: katalog w pamięci. Bez sieci.
// Dane zmyślone: lampy „Pracownia Półcień”.
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { ENV_DEMO } from '../../../scripts/demo-dane.mjs';
import { eanDemo, kategoriaAllegroDemo, parametryKategoriiAllegroDemo } from '../../../scripts/demo-dane-katalog.mjs';
import { opisKategorii } from '../../../src/domena/tresc-oferty-allegro.js';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import { zapiszUstawieniaOfertKonta, wstawOferte, ofertaPoId, zmienOferte } from '../../../src/oms/db/oferty-kanalow.ts';
import { znakInstalacji, skrotTresci } from '../../../src/moduly/magazyn/services/oferty-wspolne.js';
import { trescAllegro } from '../../../src/moduly/magazyn/services/petla-ofert-allegro.js';
import { createPetlaOfert } from '../../../src/moduly/magazyn/services/petla-ofert.js';
import { wgraneZdjeciaAllegro } from '../../../src/oms/db/oferty-kanalow.ts';
import { createAllegroClient } from '../../../src/oms/allegro/client.js';
import { katalogAllegro, wezlyAllegro } from '../../../src/integracje/kanal-modul.ts';
import { createSerwerOfertAllegro, API_ATRAPY_ALLEGRO } from '../../../deploy/proba/atrapy/allegro-oferty.mjs';
import { fixtureAllegro, daneAllegro, aktorAllegro } from '../../pomoc/allegro-konfigurator.ts';
import { createRejestrKanalow } from '../../../src/moduly/kanaly/services/rejestr-kanalow.ts';
import { createPetlaOfertAllegro } from '../../../src/moduly/magazyn/services/petla-ofert-allegro.js';
import { zapiszWyjatekCennika } from '../../../src/oms/db/cenniki-kart.ts';

const T0 = Date.parse('2026-11-01T12:00:00.000Z');
const BEZPIECZENSTWO = JSON.stringify({ typ: 'TEXT', tekst: 'Nie zostawiaj włączonej lampy bez nadzoru.' });

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
    czasWysylkiDni: 2, ...('cenniki' in ustawienia ? {} : { cennikDostaw: 'cennik-1' }), stawkaVat: '23', zwrotyId: 'zwrot-1', reklamacjeId: 'rekl-1',
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

const PATCH = /^PATCH \/sale\/product-offers\//;

/** Przebiegi co `krok` aż do stanu końcowego (najwyżej `n`). */
async function doKonca(e, p, ofertaId, { krok = 6000, n = 8 } = {}) {
  for (let i = 0; i < n && ['do_wyslania', 'wyslana', 'sprawdzana'].includes(ofertaPoId(e.db, ofertaId).stan); i++) {
    e.przesun(krok);
    await p.przebieg();
  }
  return ofertaPoId(e.db, ofertaId);
}

const REGULY = [{ doMm: [300, 300, 300], doG: 1000, cennik: 'maly' }, { cennik: 'duzy' }];
const dostawa = id => ({ handlingTime: 'P2D', shippingRates: { id } });
const patche = e => e.ciala.filter(x => PATCH.test(x.zdarzenie)).map(x => x.cialo);
async function zywe(ile = 1, ustawienia = {}) {
  const e = srodowisko({ ustawienia });
  const karty = Array.from({ length: ile }, () => karta(e.db, e.KONTO, { n: 1 }));
  for (const k of karty) e.db.prepare('UPDATE karty_produktow SET wysokosc_mm=100, glebokosc_mm=100, waga_g=500 WHERE id=?').run(k.kartaId);
  const p = e.petla();
  for (let i = 0; i < 12; i++) { e.przesun(6000); await p.przebieg(); }
  for (const k of karty) expect(ofertaPoId(e.db, k.ofertaId).stan, JSON.stringify(ofertaPoId(e.db, k.ofertaId))).toBe('aktywna');
  e.ciala.length = 0;
  return { ...e, p, karty };
}
const ustaw = (e, zmiany) => zapiszUstawieniaOfertKonta(e.db, e.KONTO, zmiany, { teraz: e.teraz().toISOString() });

describe('E3d.02-04 — dostawa Allegro', () => {
  it('wymiar zmienia regułę: jeden PATCH całego delivery, następny przebieg bez powtórki', async () => {
    const e = await zywe(1, { cenniki: REGULY });
    const k = e.karty[0];
    expect(ofertaPoId(e.db, k.ofertaId).wyslanePola.dostawa).toEqual(dostawa('maly'));
    e.db.prepare('UPDATE karty_produktow SET szerokosc_mm=400 WHERE id=?').run(k.kartaId);
    await e.p.przebieg();
    expect(patche(e)).toEqual([{ delivery: dostawa('duzy') }]);
    await doKonca(e, e.p, k.ofertaId);
    await e.p.przebieg();
    expect(patche(e)).toHaveLength(1);
    expect(ofertaPoId(e.db, k.ofertaId).wyslanePola.dostawa).toEqual(dostawa('duzy'));
  });
  // Plan §04: „zmiana wyjątku → to samo” (wyjątek z karty, E3d.02-03).
  it('wyjątek na karcie i jego zmiana: za każdym razem jeden PATCH całego delivery', async () => {
    const e = await zywe(1, { cenniki: REGULY });
    const k = e.karty[0];
    ustaw(e, { slowniki: { cenniki: [{ id: 'cen-x', nazwa: 'Kurier X' }, { id: 'cen-y', nazwa: 'Kurier Y' }] } });
    const wyjatek = cennik => zapiszWyjatekCennika(e.db, { kartaId: k.kartaId, konto: e.KONTO, cennik }, { teraz: e.teraz().toISOString() });
    wyjatek('cen-x');
    await e.p.przebieg();
    expect(patche(e)).toEqual([{ delivery: dostawa('cen-x') }]);
    await doKonca(e, e.p, k.ofertaId);
    wyjatek('cen-y');
    e.przesun(6000); await e.p.przebieg();
    expect(patche(e)).toEqual([{ delivery: dostawa('cen-x') }, { delivery: dostawa('cen-y') }]);
    await doKonca(e, e.p, k.ofertaId);
    e.przesun(6000); await e.p.przebieg();
    expect(patche(e)).toHaveLength(2);
    expect(ofertaPoId(e.db, k.ofertaId).wyslanePola.dostawa).toEqual(dostawa('cen-y'));
  });
  it('zmiana nazwy i cennika wysyła pełną treść z delivery', async () => {
    const e = await zywe(1, { cenniki: REGULY });
    e.db.prepare('UPDATE karty_produktow SET szerokosc_mm=400, nazwa=? WHERE id=?').run('Lampa po zmianie', e.karty[0].kartaId);
    await e.p.przebieg();
    expect(patche(e)).toHaveLength(1);
    expect(patche(e)[0]).toMatchObject({ name: 'Lampa po zmianie', delivery: dostawa('duzy') });
    expect(patche(e)[0]).toHaveProperty('productSet');
  });
  async function dawne(e) {
    for (const k of e.karty) {
      const o = ofertaPoId(e.db, k.ofertaId);
      const { delivery: _d, ...tresc } = trescAllegro(e.ofertaWAtrapie(o.idZewnetrzne));
      const adresy = new Map(wgraneZdjeciaAllegro(e.db, { kartaId: k.kartaId, konto: e.KONTO }).map(z => [z.adres, `zdj:${z.zdjecieId}`]));
      const normuj = v => typeof v === 'string' ? adresy.get(v) ?? v : Array.isArray(v) ? v.map(normuj)
        : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normuj(x)])) : v;
      const { dostawa: _stara, ...pola } = o.wyslanePola;
      zmienOferte(e.db, o.id, { wyslanySkrot: skrotTresci(normuj(tresc)), wyslanePola: pola });
    }
  }
  it('trzy dawne oferty: przejście bez PATCH, zapis dostawy i nowego skrótu', async () => {
    const e = await zywe(3);
    await dawne(e);
    const stare = e.karty.map(k => ofertaPoId(e.db, k.ofertaId).wyslanySkrot);
    await e.p.przebieg();
    expect(patche(e)).toEqual([]);
    e.karty.forEach((k, i) => {
      const o = ofertaPoId(e.db, k.ofertaId);
      expect(o.wyslanePola.dostawa).toEqual(dostawa('cennik-1'));
      expect(o.wyslanySkrot).not.toBe(stare[i]);
    });
    await e.p.przebieg();
    expect(patche(e)).toEqual([]);
  });
  it('dawny skrót z inną nazwą nie uprawnia do przejścia bez PATCH', async () => {
    const e = await zywe();
    await dawne(e);
    e.db.prepare('UPDATE karty_produktow SET nazwa=? WHERE id=?').run('Nowa nazwa lampy', e.karty[0].kartaId);
    await e.p.przebieg();
    expect(patche(e)).toHaveLength(1);
    expect(patche(e)[0]).toMatchObject({ name: 'Nowa nazwa lampy', delivery: dostawa('cennik-1') });
  });
  it('przejście uwzględnia dawny cennik, a nowe reguły wysyła jako samą dostawę', async () => {
    const e = await zywe();
    await dawne(e);
    ustaw(e, { cenniki: [{ cennik: 'nowy' }] });
    await e.p.przebieg();
    expect(patche(e)).toEqual([{ delivery: dostawa('nowy') }]);
  });
  it('sam czas wysyłki też zmienia skrót i wysyła cały delivery', async () => {
    const e = await zywe();
    ustaw(e, { czasWysylkiDni: 3 });
    await e.p.przebieg();
    expect(patche(e)).toEqual([{ delivery: { ...dostawa('cennik-1'), handlingTime: 'P3D' } }]);
  });
  it('60 ofert po zmianie reguły: 40 PATCH, potem pozostałe 20', async () => {
    const e = await zywe(60);
    ustaw(e, { cenniki: [{ cennik: 'nowy' }] });
    await e.p.przebieg();
    expect(patche(e)).toHaveLength(40);
    expect(patche(e).every(p => JSON.stringify(p) === JSON.stringify({ delivery: dostawa('nowy') }))).toBe(true);
    e.przesun(6000);
    await e.p.przebieg();
    expect(patche(e)).toHaveLength(60);
  });
  it('utrata wagi: problem karty z odmową, bez PATCH', async () => {
    const e = await zywe(1, { cenniki: REGULY });
    e.db.prepare('UPDATE karty_produktow SET waga_g=NULL WHERE id=?').run(e.karty[0].kartaId);
    await e.p.przebieg();
    expect(patche(e)).toEqual([]);
    expect(ofertaPoId(e.db, e.karty[0].ofertaId).problemy).toEqual(expect.arrayContaining([expect.objectContaining({ kod: 'karta', tekst: expect.stringMatching(/wymiary|wag/i) })]));
  });
});

describe('E3d.02-04 — dostawa ERLI', () => {
  async function erli() {
    const db = openOmsDb(':memory:', { moduly: modulyDla(ENV_DEMO) });
    sprzatanie.push(() => db.close());
    const konto = 'erli-fikcyjne';
    zapiszUstawieniaOfertKonta(db, konto, { czynne: true, narzutProcent: 0, stalaIlosc: 5, czasWysylkiDni: 2, cennikDostaw: 'stary', stawkaVat: '23' });
    const id = utworzKarte(db, { nazwa: 'Lampa testowa', cena_gr: 5900, stawka_vat: '23' });
    db.prepare("INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, adres_zrodlowy, utworzono_at) VALUES (?,0,'reczne','https://przyklad.invalid/lampa.jpg',?)").run(id, new Date(T0).toISOString());
    const o = wstawOferte(db, { kartaId: id, kanal: konto, idZewnetrzne: 'lampa-1', tryb: 'zarzadzana', stan: 'do_wyslania' });
    let produkt;
    const ciala = [];
    const katalog = {
      odczytOfert: async () => ({ ok: true, dane: produkt ? [produkt] : [] }),
      wystawOferte: async (_id, body) => { produkt = { ...body, externalId: 'lampa-1', buyableProblems: [] }; return { ok: true, dane: {} }; },
      stanOferty: async () => ({ ok: true, dane: produkt }),
      zmienOferte: async (_id, body) => { ciala.push(body); produkt = { ...produkt, ...body }; return { ok: true, dane: {} }; },
    };
    let czas = T0;
    const p = createPetlaOfert({ db, konta: () => [{ klucz: konto, katalog }], teraz: () => new Date(czas) });
    await p.przebieg(); czas += 60_000; await p.przebieg();
    return { db, konto, o, p, ciala, zamroz: () => { produkt.frozen = ['deliveryPriceList']; } };
  }
  it('POST zapamiętuje cennik, sama zmiana cennika daje minimalny PATCH i zapis pola', async () => {
    const e = await erli();
    expect(ofertaPoId(e.db, e.o.id).wyslanePola.deliveryPriceList).toBe('stary');
    zapiszUstawieniaOfertKonta(e.db, e.konto, { cenniki: [{ cennik: 'nowy' }] });
    await e.p.przebieg();
    expect(e.ciala).toEqual([{ deliveryPriceList: 'nowy' }]);
    expect(ofertaPoId(e.db, e.o.id).wyslanePola.deliveryPriceList).toBe('nowy');
    await e.p.przebieg();
    expect(e.ciala).toHaveLength(1);
  });
  it('zmiana nazwy i cennika wysyła pełną treść, nie samo deliveryPriceList', async () => {
    const e = await erli();
    e.db.prepare('UPDATE karty_produktow SET nazwa=? WHERE id=?').run('Lampa po zmianie', e.o.kartaId);
    zapiszUstawieniaOfertKonta(e.db, e.konto, { cenniki: [{ cennik: 'nowy' }] });
    await e.p.przebieg();
    expect(e.ciala).toHaveLength(1);
    expect(e.ciala[0]).toMatchObject({ name: 'Lampa po zmianie', deliveryPriceList: 'nowy' });
  });
  it('brak zapamiętanego cennika wymaga pełnego PATCH', async () => {
    const e = await erli();
    const { deliveryPriceList: _d, ...pola } = ofertaPoId(e.db, e.o.id).wyslanePola;
    zmienOferte(e.db, e.o.id, { wyslanePola: pola });
    zapiszUstawieniaOfertKonta(e.db, e.konto, { cenniki: [{ cennik: 'nowy' }] });
    await e.p.przebieg();
    expect(e.ciala).toHaveLength(1);
    expect(e.ciala[0]).toMatchObject({ name: 'Lampa testowa', deliveryPriceList: 'nowy' });
  });
  it('zamrożony cennik nie dostaje PATCH', async () => {
    const e = await erli();
    e.zamroz();
    zapiszUstawieniaOfertKonta(e.db, e.konto, { cenniki: [{ cennik: 'nowy' }] });
    await e.p.przebieg();
    expect(e.ciala).toEqual([]);
    expect(ofertaPoId(e.db, e.o.id).wyslanePola.deliveryPriceList).toBe('stary');
  });
});
