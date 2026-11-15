// PRZ-160 E3.26/E3.27: hamulce pętli ofert Allegro (zdejmowanie, 5xx/429 komend, limit zapisów na przebieg) i „Ponów” bez drugiego POST.
// Środowisko testowe skopiowane z petla-ofert-allegro-pomiar-prz160e3.test.js (atrapa API Allegro w procesie).
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
import { createRejestrKanalow } from '../../../src/moduly/kanaly/services/rejestr-kanalow.ts';
import { createPetlaOfertAllegro, LIMIT_ZAPISOW_PRZEBIEGU, REZERWA_KOMEND_PRZEBIEGU } from '../../../src/moduly/magazyn/services/petla-ofert-allegro.js';
import { zmianyPonowienia, zmianyZdjecia } from '../../../src/moduly/magazyn/oferty.js';

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

// ── E3.17: odpowiedzi z pomiarów P12, P17, P18 (fixture `e3-pomiar-*.json`) ──
const pomiar = (nazwa) => JSON.parse(readFileSync(new URL(`../../fixtures/allegro/${nazwa}`, import.meta.url), 'utf8'));
const P12 = pomiar('e3-pomiar-p12-422-brak-parametrow-produktu.json');
const P17 = pomiar('e3-pomiar-p17-publikacja-szkicu.json');
const P18 = pomiar('e3-pomiar-p18-oplaty.json');
const DOK = pomiar('e3-dok-slowniki.json');
const odp = (status, cialo) => new Response(JSON.stringify(cialo), { status, headers: { 'Content-Type': 'application/json' } });

const PODGLAD = /^POST \/pricing\/offer-fee-preview$/;
const OPERACJA = /^GET \/sale\/product-offers\/[^/]+\/operations\//;
const ZAPISY = /^(PUT|PATCH) /;
const cialaPo = (e, wzor, od = 0) => e.ciala.slice(od).filter((c) => wzor.test(c.zdarzenie));
const przebieg = async (e, p, ms = MIN) => { e.przesun(ms); await p.przebieg(); };

const PATCH = /^PATCH \/sale\/product-offers\//;
const PUT_ILOSCI = /^PUT \/sale\/offer-quantity-change-commands\//;
const PUT_CENY = /^PUT \/sale\/offer-price-change-commands\//;
const ENDED = (c) => c.cialo?.publication?.status === 'ENDED';
const zdjecia = (e, od = 0) => cialaPo(e, PATCH, od).filter(ENDED).length;
const operacja422 = (m, s) => (OPERACJA.test(`${m} ${s}`) ? odp(P17.ended_operacja.status, P17.ended_operacja.body) : null);
/** Ponów z ekranu karty: ta sama zmiana, którą zapisuje trasa `POST /magazyn/:id/oferty/:ofertaId/ponow`. */
const ponow = (e, id) => zmienOferte(e.db, id, zmianyPonowienia(ofertaPoId(e.db, id), true), { teraz: e.teraz().toISOString() });

async function wystawiona(e, opcje) {
  const k = karta(e.db, e.KONTO, opcje);
  const p = e.petla();
  const o = await doKonca(e, p, k.ofertaId);
  expect(o.stan).toBe('aktywna');
  return { ...k, p, o };
}

describe('E3.26a — zdejmowanie: Allegro nie kończy oferty', () => {
  it('operacja ENDED kończy się 422, oferta dalej ACTIVE → przerwy rosną, po 5 próbach problem i cisza; Ponów zeruje licznik', async () => {
    const e = srodowisko();
    const { ofertaId, kartaId, p, o } = await wystawiona(e);
    e.db.prepare('UPDATE karty_produktow SET wycofana = 1 WHERE id = ?').run(kartaId);
    e.st.awaria = operacja422;
    const przed = e.ciala.length;
    const przerwy = [];
    let proby = 0;
    for (let i = 0; i < 80 && ofertaPoId(e.db, ofertaId).stan !== 'problem'; i++) {
      await przebieg(e, p, 2 * MIN);
      const w = ofertaPoId(e.db, ofertaId);
      // Przerwa zapisana w przebiegu, w którym przybyła próba (odczyt po operacji 422: oferta dalej ACTIVE).
      const n = w.wyslanePola.probyZdjecia ?? 0;
      if (n > proby && w.stan === 'aktywna') przerwy.push(Date.parse(w.nastepnaProbaAt) - e.teraz().getTime());
      proby = n;
    }
    const po = ofertaPoId(e.db, ofertaId);
    expect(zdjecia(e, przed)).toBe(5);
    expect(po.stan).toBe('problem');
    expect(po.wyslanePola.probyZdjecia).toBe(5);
    expect(po.nastepnaProbaAt).toBeNull();
    // Karta wycofana (bez flagi „zdejmij”): w OMS działają „Zdejmij ofertę” i „Wyślij ponownie” (Ponów).
    expect(po.problemy).toEqual([{ kod: 'zdejmowanie', tekst: expect.stringMatching(/Allegro nie zakończyło oferty.*5 prób.*w Allegro.*„Zdejmij ofertę”.*„Wyślij ponownie”/) }]);
    // Przerwy po kolejnych próbach nie maleją, ostatnia dłuższa od pierwszej.
    expect(przerwy).toHaveLength(4);
    for (let i = 1; i < przerwy.length; i++) expect(przerwy[i]).toBeGreaterThanOrEqual(przerwy[i - 1]);
    expect(przerwy[3]).toBeGreaterThan(przerwy[0]);
    const przed2 = e.ciala.length;
    for (let i = 0; i < 4; i++) await przebieg(e, p, 2 * 60 * MIN);
    expect(zdjecia(e, przed2)).toBe(0);
    expect(e.ofertaWAtrapie(o.idZewnetrzne).publication.status).toBe('ACTIVE');
    // Człowiek: Ponów → licznik od zera, następny przebieg znów wysyła ENDED (i tym razem Allegro kończy ofertę).
    e.st.awaria = null;
    ponow(e, ofertaId);
    expect(ofertaPoId(e.db, ofertaId)).toMatchObject({ stan: 'aktywna', liczbaProb: 0, problemy: [] });
    expect(ofertaPoId(e.db, ofertaId).wyslanePola.probyZdjecia).toBeUndefined();
    await przebieg(e, p);
    expect(zdjecia(e, przed2)).toBe(1);
    const koniec = await doKonca(e, p, ofertaId);
    expect(koniec.stan).toBe('nieaktywna');
    expect(e.ofertaWAtrapie(o.idZewnetrzne).publication.status).toBe('ENDED');
  });

  it('PATCH ENDED odrzucony (422) za każdym razem → po 5 próbach problem „zdejmowanie”, bez kolejnych PATCH', async () => {
    const e = srodowisko();
    const { ofertaId, kartaId, p } = await wystawiona(e);
    e.db.prepare('UPDATE karty_produktow SET wycofana = 1 WHERE id = ?').run(kartaId);
    e.st.awaria = (m, s) => (m === 'PATCH' && s.startsWith('/sale/product-offers/') ? odp(422, { errors: [{ code: 'VALIDATION_ERROR' }] }) : null);
    const przed = e.ciala.length;
    for (let i = 0; i < 12; i++) await przebieg(e, p, 30 * MIN);
    const po = ofertaPoId(e.db, ofertaId);
    expect(zdjecia(e, przed)).toBe(5);
    expect(po.stan).toBe('problem');
    expect(po.problemy).toEqual([{ kod: 'zdejmowanie', tekst: expect.stringMatching(/Allegro nie zakończyło oferty/) }]);
  });

  it('PATCH ENDED 503 przez 25 min (przebieg co 5 min) → bez problemu i bez liczenia prób; po powrocie Allegro oferta zakończona', async () => {
    const e = srodowisko();
    const { ofertaId, kartaId, p, o } = await wystawiona(e);
    e.db.prepare('UPDATE karty_produktow SET wycofana = 1 WHERE id = ?').run(kartaId);
    e.st.awaria = (m, s) => (m === 'PATCH' && s.startsWith('/sale/product-offers/') ? odp(503, { errors: [{ code: 'ServiceUnavailable' }] }) : null);
    const przed = e.ciala.length;
    for (let i = 0; i < 5; i++) {
      await przebieg(e, p, 5 * MIN);
      const w = ofertaPoId(e.db, ofertaId);
      expect(w.stan).toBe('aktywna');
      expect(w.wyslanePola.probyZdjecia ?? 0).toBe(0);
    }
    expect(zdjecia(e, przed)).toBeGreaterThanOrEqual(3);
    e.st.awaria = null;
    for (let i = 0; i < 6 && ofertaPoId(e.db, ofertaId).stan !== 'nieaktywna'; i++) await przebieg(e, p, 5 * MIN);
    expect(ofertaPoId(e.db, ofertaId)).toMatchObject({ stan: 'nieaktywna', problemy: [] });
    expect(ofertaPoId(e.db, ofertaId).wyslanePola.bledyZdjecia).toBeUndefined();
    expect(e.ofertaWAtrapie(o.idZewnetrzne).publication.status).toBe('ENDED');
  });

  it('PATCH ENDED 429 z Retry-After: 600 → następna próba za 600 s, próba nie liczy się do limitu', async () => {
    const e = srodowisko();
    const { ofertaId, kartaId, p } = await wystawiona(e);
    e.db.prepare('UPDATE karty_produktow SET wycofana = 1 WHERE id = ?').run(kartaId);
    e.st.awaria = (m, s) => (m === 'PATCH' && s.startsWith('/sale/product-offers/')
      ? new Response('{}', { status: 429, headers: { 'Retry-After': '600', 'Content-Type': 'application/json' } }) : null);
    const przed = e.ciala.length;
    await przebieg(e, p);
    const w = ofertaPoId(e.db, ofertaId);
    expect(zdjecia(e, przed)).toBe(1);
    expect(Date.parse(w.nastepnaProbaAt) - e.teraz().getTime()).toBe(300_000);
    expect(w.wyslanePola.probyZdjecia ?? 0).toBe(0);
    await przebieg(e, p, 5 * MIN - 1000);
    expect(zdjecia(e, przed)).toBe(1);
    await przebieg(e, p, 1000);
    expect(zdjecia(e, przed)).toBe(2);
  });

  it('PATCH ENDED 429 z Retry-After: 60 → następna próba za 60 s (krótszy niż przerwa rosnąca 5 min)', async () => {
    const e = srodowisko();
    const { ofertaId, kartaId, p } = await wystawiona(e);
    e.db.prepare('UPDATE karty_produktow SET wycofana = 1 WHERE id = ?').run(kartaId);
    e.st.awaria = (m, s) => (m === 'PATCH' && s.startsWith('/sale/product-offers/')
      ? new Response('{}', { status: 429, headers: { 'Retry-After': '60', 'Content-Type': 'application/json' } }) : null);
    await przebieg(e, p);
    const w = ofertaPoId(e.db, ofertaId);
    expect(Date.parse(w.nastepnaProbaAt) - e.teraz().getTime()).toBe(60_000);
  });

  it('licznik prób zdjęcia nie zależy od prób komend: liczbaProb 4 z wcześniejszych komend → dalej 5 prób ENDED', async () => {
    const e = srodowisko();
    const { ofertaId, kartaId, p } = await wystawiona(e);
    zmienOferte(e.db, ofertaId, { liczbaProb: 4 }, { teraz: e.teraz().toISOString() });
    e.db.prepare('UPDATE karty_produktow SET wycofana = 1 WHERE id = ?').run(kartaId);
    e.st.awaria = operacja422;
    const przed = e.ciala.length;
    for (let i = 0; i < 80 && ofertaPoId(e.db, ofertaId).stan !== 'problem'; i++) await przebieg(e, p, 5 * MIN);
    expect(ofertaPoId(e.db, ofertaId).stan).toBe('problem');
    expect(zdjecia(e, przed)).toBe(5);
  });

  it('„Zdejmij” z ekranu przy problemie „zdejmowanie” zeruje licznik → pętla znów wysyła ENDED', async () => {
    const e = srodowisko();
    const { ofertaId, kartaId, p, o } = await wystawiona(e);
    e.db.prepare('UPDATE karty_produktow SET wycofana = 1 WHERE id = ?').run(kartaId);
    zmienOferte(e.db, ofertaId, { stan: 'problem', nastepnaProbaAt: null, wyslanePola: { ...o.wyslanePola, probyZdjecia: 5 },
      problemy: [{ kod: 'zdejmowanie', tekst: 'Allegro nie zakończyło oferty po 5 próbach' }] }, { teraz: e.teraz().toISOString() });
    const przed = e.ciala.length;
    await przebieg(e, p, 2 * 60 * MIN);
    expect(zdjecia(e, przed)).toBe(0);
    zmienOferte(e.db, ofertaId, zmianyZdjecia(ofertaPoId(e.db, ofertaId)), { teraz: e.teraz().toISOString() });
    await przebieg(e, p);
    expect(zdjecia(e, przed)).toBe(1);
    expect((await doKonca(e, p, ofertaId)).stan).toBe('nieaktywna');
  });

  it('flaga „zdejmij” (Ponów i Zdejmij niedostępne): problem wskazuje zakończenie w Allegro, a następny odczyt to zauważa', async () => {
    const e = srodowisko();
    const { ofertaId, p, o } = await wystawiona(e);
    zmienOferte(e.db, ofertaId, zmianyZdjecia(o), { teraz: e.teraz().toISOString() });
    e.st.awaria = operacja422;
    for (let i = 0; i < 80 && ofertaPoId(e.db, ofertaId).stan !== 'problem'; i++) await przebieg(e, p, 5 * MIN);
    const po = ofertaPoId(e.db, ofertaId);
    expect(po.problemy).toEqual([{ kod: 'zdejmowanie', tekst: expect.stringMatching(/ręcznie w Allegro/) }]);
    expect(po.problemy[0].tekst).not.toMatch(/Wyślij ponownie|Zdejmij ofertę|Ponów/);
    e.st.awaria = null;
    e.zmienWAtrapie(o.idZewnetrzne, (x) => ({ ...x, publication: { ...x.publication, status: 'ENDED' } }));
    await przebieg(e, p);
    expect(ofertaPoId(e.db, ofertaId)).toMatchObject({ stan: 'nieaktywna', problemy: [] });
  });

  it('karta znów w sprzedaży po problemie „zdejmowanie” → synchronizacja sama zdejmuje problem i licznik prób', async () => {
    const e = srodowisko();
    const { ofertaId, kartaId, p, o } = await wystawiona(e);
    zmienOferte(e.db, ofertaId, { stan: 'problem', nastepnaProbaAt: null, wyslanePola: { ...o.wyslanePola, probyZdjecia: 5, bledyZdjecia: 2 },
      problemy: [{ kod: 'zdejmowanie', tekst: 'Allegro nie zakończyło oferty po 5 próbach' }] }, { teraz: e.teraz().toISOString() });
    e.db.prepare('UPDATE karty_produktow SET wycofana = 0 WHERE id = ?').run(kartaId);
    await przebieg(e, p);
    const w = ofertaPoId(e.db, ofertaId);
    expect(w).toMatchObject({ stan: 'aktywna', problemy: [] });
    expect(w.wyslanePola.probyZdjecia).toBeUndefined();
    expect(w.wyslanePola.bledyZdjecia).toBeUndefined();
  });
});

describe('E3.26b — komenda ilości: 5xx/429 na PUT', () => {
  const odp503 = (retryAfter) => (m, s) => (m === 'PUT' && /quantity/.test(s)
    ? new Response(JSON.stringify({ errors: [{ code: 'ServiceUnavailable' }] }),
      { status: 503, headers: { 'Content-Type': 'application/json', ...(retryAfter ? { 'Retry-After': String(retryAfter) } : {}) } })
    : null);

  it('503 z Retry-After: 120 → kolejny PUT dopiero po 120 s, nie w następnym przebiegu', async () => {
    const e = srodowisko();
    const { ofertaId, p, o } = await wystawiona(e);
    e.zmienWAtrapie(o.idZewnetrzne, (x) => ({ ...x, stock: { ...x.stock, available: 3 } }));
    e.st.awaria = odp503(120);
    await przebieg(e, p);
    const puty = () => e.zdarzenia.filter((z) => PUT_ILOSCI.test(z)).length;
    const n1 = puty();
    expect(n1).toBeGreaterThanOrEqual(1);
    const w = ofertaPoId(e.db, ofertaId);
    expect(Date.parse(w.nastepnaProbaAt) - e.teraz().getTime()).toBe(120_000);
    e.st.awaria = null;
    await przebieg(e, p);
    expect(puty()).toBe(n1);
    await przebieg(e, p);
    expect(puty()).toBe(n1 + 1);
    expect(e.ofertaWAtrapie(o.idZewnetrzne).stock.available).toBe(5);
  });

  it('503 bez Retry-After → przerwa rosnąca wg liczby prób, w przerwie żadnego PUT', async () => {
    const e = srodowisko();
    const { ofertaId, p, o } = await wystawiona(e);
    e.zmienWAtrapie(o.idZewnetrzne, (x) => ({ ...x, stock: { ...x.stock, available: 3 } }));
    e.st.awaria = odp503(null);
    const przerwy = [];
    for (let i = 0; i < 3; i++) {
      // Czekamy do końca przerwy (pierwszy raz od razu), potem jeden przebieg z wysyłką.
      const w0 = ofertaPoId(e.db, ofertaId);
      const czekaj = w0.nastepnaProbaAt ? Date.parse(w0.nastepnaProbaAt) - e.teraz().getTime() : 1000;
      await przebieg(e, p, Math.max(1000, czekaj));
      const w = ofertaPoId(e.db, ofertaId);
      expect(w.liczbaProb).toBe(i + 1);
      przerwy.push(Date.parse(w.nastepnaProbaAt) - e.teraz().getTime());
    }
    expect(przerwy).toEqual([30_000, 60_000, 120_000]);
    const puty = e.zdarzenia.filter((z) => PUT_ILOSCI.test(z)).length;
    await przebieg(e, p, 60_000);
    expect(e.zdarzenia.filter((z) => PUT_ILOSCI.test(z)).length).toBe(puty);
    expect(ofertaPoId(e.db, ofertaId).stan).toBe('aktywna');
  });
});

describe('E3.26c — limit zapisów na przebieg konta', () => {
  it(`${LIMIT_ZAPISOW_PRZEBIEGU + 5} ofert do zdjęcia → w przebiegu ${LIMIT_ZAPISOW_PRZEBIEGU - REZERWA_KOMEND_PRZEBIEGU} PATCH (reszta limitu dla komend), pozostałe w następnym, bez błędu`, async () => {
    const e = srodowisko();
    const { o: pierwsza, kartaId: k0, p } = await wystawiona(e);
    const wzor = e.ofertaWAtrapie(pierwsza.idZewnetrzne);
    const at = e.teraz().toISOString();
    const ids = [];
    for (let i = 1; i < LIMIT_ZAPISOW_PRZEBIEGU + 5; i++) {
      const kartaId = utworzKarte(e.db, { nazwa: `Kinkiet Półcień nr ${i}`, cena_gr: 4900, stawka_vat: '23' }, { at });
      const id = String(9_000_000 + i);
      e.wstawDoAtrapy({ ...wzor, id, external: { id: `${znakInstalacji(e.db)}-K${kartaId}` } });
      ids.push(wstawOferte(e.db, { kartaId, kanal: e.KONTO, idZewnetrzne: id, tryb: 'zarzadzana', stan: 'aktywna' }, { teraz: at }).id);
    }
    e.db.prepare('UPDATE karty_produktow SET wycofana = 1').run();
    expect(k0).toBeGreaterThan(0);
    const przed = e.ciala.length;
    await przebieg(e, p);
    const naPatch = LIMIT_ZAPISOW_PRZEBIEGU - REZERWA_KOMEND_PRZEBIEGU;
    expect(naPatch).toBeGreaterThan(0);
    expect(zdjecia(e, przed)).toBe(naPatch);
    const czekajace = ids.map((id) => ofertaPoId(e.db, id)).filter((w) => w.stan === 'aktywna');
    expect(czekajace.length).toBe(LIMIT_ZAPISOW_PRZEBIEGU + 5 - naPatch);
    for (const w of czekajace) expect(w).toMatchObject({ blad: null, problemy: [], liczbaProb: 0 });
    const przed2 = e.ciala.length;
    await przebieg(e, p);
    expect(zdjecia(e, przed2)).toBe(LIMIT_ZAPISOW_PRZEBIEGU + 5 - naPatch);
  });

  /** `n` ofert wycofanych kart (aktywnych w Allegro) — kandydaci do zdjęcia. */
  function doZdjecia(e, wzor, n, od = 9_100_000) {
    const at = e.teraz().toISOString();
    for (let i = 1; i <= n; i++) {
      const kartaId = utworzKarte(e.db, { nazwa: `Kinkiet Półcień nr ${i}`, cena_gr: 4900, stawka_vat: '23' }, { at });
      e.db.prepare('UPDATE karty_produktow SET wycofana = 1 WHERE id = ?').run(kartaId);
      const id = String(od + i);
      e.wstawDoAtrapy({ ...wzor, id, stock: { ...wzor.stock, available: 5 }, external: { id: `${znakInstalacji(e.db)}-K${kartaId}` } });
      wstawOferte(e.db, { kartaId, kanal: e.KONTO, idZewnetrzne: id, tryb: 'zarzadzana', stan: 'aktywna' }, { teraz: at });
    }
  }

  it('150 ofert do zdjęcia + zmiana ilości jednej oferty → komenda ilości wychodzi w pierwszym przebiegu', async () => {
    const e = srodowisko();
    const { o, p } = await wystawiona(e);
    e.zmienWAtrapie(o.idZewnetrzne, (x) => ({ ...x, stock: { ...x.stock, available: 3 } }));
    doZdjecia(e, e.ofertaWAtrapie(o.idZewnetrzne), 150);
    const przed = e.ciala.length;
    await przebieg(e, p, 5 * MIN);
    expect(zdjecia(e, przed)).toBe(LIMIT_ZAPISOW_PRZEBIEGU - REZERWA_KOMEND_PRZEBIEGU);
    expect(cialaPo(e, PUT_ILOSCI, przed)).toHaveLength(1);
    expect(e.ofertaWAtrapie(o.idZewnetrzne).stock.available).toBe(5);
  });

  it(`komendy też w limicie: ${REZERWA_KOMEND_PRZEBIEGU + 2} zmian ceny + pełna pula PATCH → ${REZERWA_KOMEND_PRZEBIEGU} komend w przebiegu, reszta w następnym`, async () => {
    const e = srodowisko();
    const karty = Array.from({ length: REZERWA_KOMEND_PRZEBIEGU + 2 }, (_, i) => karta(e.db, e.KONTO, { nazwa: `Lampa Gliwka nr ${i + 1}`, n: 1 }));
    const p = e.petla();
    for (let i = 0; i < 10 && karty.some((k) => ofertaPoId(e.db, k.ofertaId).stan !== 'aktywna'); i++) await przebieg(e, p, 6000);
    for (const k of karty) expect(ofertaPoId(e.db, k.ofertaId).stan).toBe('aktywna');
    karty.forEach((k, i) => e.db.prepare('UPDATE karty_produktow SET cena_gr = ? WHERE id = ?').run(5901 + i, k.kartaId));
    doZdjecia(e, e.ofertaWAtrapie(ofertaPoId(e.db, karty[0].ofertaId).idZewnetrzne), LIMIT_ZAPISOW_PRZEBIEGU);
    const przed = e.ciala.length;
    await przebieg(e, p, 5 * MIN);
    expect(zdjecia(e, przed)).toBe(LIMIT_ZAPISOW_PRZEBIEGU - REZERWA_KOMEND_PRZEBIEGU);
    expect(cialaPo(e, PUT_CENY, przed)).toHaveLength(REZERWA_KOMEND_PRZEBIEGU);
    const przed2 = e.ciala.length;
    await przebieg(e, p, 5 * MIN);
    expect(cialaPo(e, PUT_CENY, przed2)).toHaveLength(2);
  });
});

describe('E3.27 — „Ponów” na ofercie z numerem Allegro nie wystawia drugiej', () => {
  it('problem „komenda” → Ponów → 0 POST, następny przebieg wysyła komendę ilości', async () => {
    const e = srodowisko();
    const { ofertaId, p, o } = await wystawiona(e);
    const posty = e.ile(POST);
    expect(posty).toBe(1);
    e.zmienWAtrapie(o.idZewnetrzne, (x) => ({ ...x, stock: { ...x.stock, available: 3 } }));
    e.st.awaria = (m, s) => (m === 'PUT' && /quantity/.test(s) ? odp(422, { errors: [{ code: 'VALIDATION_ERROR', message: 'Ilość poza zakresem konta' }] }) : null);
    for (let i = 0; i < 12; i++) await przebieg(e, p);
    expect(ofertaPoId(e.db, ofertaId).problemy).toEqual([expect.objectContaining({ kod: 'komenda' })]);
    e.st.awaria = null;
    ponow(e, ofertaId);
    const w = ofertaPoId(e.db, ofertaId);
    expect(w).toMatchObject({ stan: 'aktywna', liczbaProb: 0, problemy: [], blad: null, nastepnaProbaAt: null, idZewnetrzne: o.idZewnetrzne });
    expect(w.wyslanePola.komendaIlosci).toBeUndefined();
    const puty = e.ile(PUT_ILOSCI);
    for (let i = 0; i < 3; i++) await przebieg(e, p);
    expect(e.ile(POST)).toBe(posty);
    expect(e.ile(PUT_ILOSCI)).toBe(puty + 1);
    expect(e.ofertaWAtrapie(o.idZewnetrzne).stock.available).toBe(5);
    expect(ofertaPoId(e.db, ofertaId).stan).toBe('aktywna');
  });

  it('problem „zakonczona” z numerem → Ponów → nieaktywna, bez POST (pętla znów sprawdza wznowienie)', async () => {
    const e = srodowisko();
    const { ofertaId, p, o } = await wystawiona(e);
    e.zmienWAtrapie(o.idZewnetrzne, (x) => ({ ...x, stock: { ...x.stock, available: 3 }, publication: { ...x.publication, status: 'ENDED' } }));
    await przebieg(e, p);
    expect(ofertaPoId(e.db, ofertaId).problemy).toEqual([{ kod: 'zakonczona', sztuk: 3 }]);
    ponow(e, ofertaId);
    expect(ofertaPoId(e.db, ofertaId).stan).toBe('nieaktywna');
    for (let i = 0; i < 3; i++) await przebieg(e, p);
    expect(e.ile(POST)).toBe(1);
    expect(ofertaPoId(e.db, ofertaId).problemy).toEqual([{ kod: 'zakonczona', sztuk: 3 }]);
  });

  it('zwykła nieudana wysyłka (numer tymczasowy ext:) → Ponów → do_wyslania, pętla wystawia', async () => {
    const e = srodowisko();
    const { ofertaId } = karta(e.db, e.KONTO);
    e.st.awaria = (m, s) => (m === 'POST' && s === '/sale/product-offers' ? odp(P12.status, P12.body) : null);
    const p = e.petla();
    await p.przebieg();
    expect(ofertaPoId(e.db, ofertaId).stan).toBe('blad');
    e.st.awaria = null;
    ponow(e, ofertaId);
    expect(ofertaPoId(e.db, ofertaId)).toMatchObject({ stan: 'do_wyslania', liczbaProb: 0, blad: null });
    await przebieg(e, p);
    expect(e.ile(POST)).toBe(2);
  });

  it('walidacja po POST (numer jest, odczytu nie było) → Ponów → pętla sprawdza ofertę i ją aktywuje, bez drugiego POST', async () => {
    const e = srodowisko();
    const k = karta(e.db, e.KONTO);
    const p = e.petla();
    let raz = true;
    e.st.awaria = (m, s) => {
      const r = /^\/sale\/product-offers\/([^/]+)$/.exec(s);
      if (m === 'GET' && r && raz) return odp(200, { ...e.ofertaWAtrapie(r[1]), validation: { errors: [{ code: 'E', userMessage: 'Brak parametru Kolor' }] } });
      return null;
    };
    const o1 = await doKonca(e, p, k.ofertaId);
    expect(o1.stan).toBe('problem');
    expect(o1.idZewnetrzne).not.toMatch(/^ext:/);
    expect(o1.odczytStatus ?? null).toBeNull();
    raz = false;
    e.st.awaria = null;
    ponow(e, k.ofertaId);
    expect(ofertaPoId(e.db, k.ofertaId).stan).toBe('sprawdzana');
    for (let i = 0; i < 6 && ofertaPoId(e.db, k.ofertaId).stan !== 'aktywna'; i++) await przebieg(e, p, 5 * MIN);
    const o3 = ofertaPoId(e.db, k.ofertaId);
    expect(o3.stan).toBe('aktywna');
    expect(e.ofertaWAtrapie(o3.idZewnetrzne).publication.status).toBe('ACTIVE');
    expect(e.ile(POST)).toBe(1);
  });

  it('bez numeru albo poza Allegro → do_wyslania; z numerem → stan wg ostatniego odczytu, bez odczytu → sprawdzana', () => {
    const baza = { liczbaProb: 3, odczytStatus: 'ACTIVE',
      wyslanePola: { komendaCeny: { id: 'x' }, produktId: '42', etap: 'aktywacja', operacja: 'op-1', probyZdjecia: 5, bledyZdjecia: 2 } };
    expect(zmianyPonowienia({ ...baza, idZewnetrzne: '' }, true).stan).toBe('do_wyslania');
    expect(zmianyPonowienia({ ...baza, idZewnetrzne: 'ext:ZNAK-K7' }, true).stan).toBe('do_wyslania');
    expect(zmianyPonowienia({ ...baza, idZewnetrzne: '7701' }, false).stan).toBe('do_wyslania');
    expect(zmianyPonowienia({ ...baza, idZewnetrzne: '7701', odczytStatus: 'ACTIVE' }, true))
      .toEqual({ stan: 'aktywna', liczbaProb: 0, blad: null, nastepnaProbaAt: null, problemy: [],
        wyslanePola: { produktId: '42', etap: 'aktywacja', operacja: 'op-1' } });
    expect(zmianyPonowienia({ ...baza, idZewnetrzne: '7701', odczytStatus: 'INACTIVE' }, true).stan).toBe('nieaktywna');
    expect(zmianyPonowienia({ ...baza, idZewnetrzne: '7701', odczytStatus: null }, true))
      .toEqual({ stan: 'sprawdzana', liczbaProb: 0, blad: null, nastepnaProbaAt: null, problemy: [],
        wyslanePola: { produktId: '42', etap: null, operacja: null } });
  });

  it('Zdejmij z ekranu: flaga, zero prób komend i zdjęcia, bez przerwy', () => {
    const o = { liczbaProb: 4, nastepnaProbaAt: '2026-11-01T13:00:00.000Z', wyslanePola: { produktId: '42', probyZdjecia: 5, bledyZdjecia: 3 } };
    expect(zmianyZdjecia(o)).toEqual({ wyslanePola: { produktId: '42', zdejmij: true }, liczbaProb: 0, nastepnaProbaAt: null });
  });
});
