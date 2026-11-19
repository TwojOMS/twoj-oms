// Pętla wysyłki ofert Allegro (do_wyslania → wyslana → sprawdzana → aktywna) z odzyskiem po
// sygnaturze (D31). Całość na atrapie ofert Allegro przez PRAWDZIWY rejestr kanałów (bariera operacji
// niejednoznacznych) i prawdziwego klienta Allegro. Żadnej sieci: atrapa odpowiada z pamięci.
// Dane zmyślone: lampy „Pracownia Półcień”.
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { ENV_DEMO } from '../../../scripts/demo-dane.mjs';
import { eanDemo, kategoriaAllegroDemo, parametryKategoriiAllegroDemo } from '../../../scripts/demo-dane-katalog.mjs';
import { opisKategorii } from '../../../src/domena/tresc-oferty-allegro.js';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import {
  zapiszUstawieniaOfertKonta,
  wstawOferte,
  ofertaPoId,
  zmienOferte,
} from '../../../src/oms/db/oferty-kanalow.ts';
import { ustawZnacznikAi } from '../../../src/moduly/magazyn/services/znacznik-ai.js';
import { LIMIT_STRONY_OFERT } from '../../../src/oms/allegro/client.js';
import { znakInstalacji } from '../../../src/moduly/magazyn/services/oferty-wspolne.js';
import { createAllegroClient } from '../../../src/oms/allegro/client.js';
import { katalogAllegro, wezlyAllegro } from '../../../src/integracje/kanal-modul.ts';
import { createSerwerOfertAllegro, API_ATRAPY_ALLEGRO } from '../../../deploy/proba/atrapy/allegro-oferty.mjs';
import { fixtureAllegro, daneAllegro, aktorAllegro } from '../../pomoc/allegro-konfigurator.ts';
import { createRejestrKanalow } from '../../../src/moduly/kanaly/services/rejestr-kanalow.ts';
import { createPetlaOfertAllegro } from '../../../src/moduly/magazyn/services/petla-ofert-allegro.js';
import { ustawCeneReczna } from '../../../src/oms/db/ceny-kanalow.js';

const T0 = Date.parse('2026-11-01T12:00:00.000Z');
const BEZPIECZENSTWO = JSON.stringify({ typ: 'TEXT', tekst: 'Nie zostawiaj włączonej lampy bez nadzoru.' });
const MIN = 60_000;

const sprzatanie = [];
afterEach(() => {
  for (const f of sprzatanie.splice(0)) f();
});

const zawies = (signal) =>
  new Promise((_r, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

/** Karta z kategorią z mapy, regułami, marką, GPSR konta, `n` zdjęciami i EAN demo (D34 → katalog-id). */
function karta(db, konto, { nazwa = 'Lampa stołowa Gliwka z kloszem', n = 2 } = {}) {
  const id = utworzKarte(
    db,
    {
      nazwa,
      cena_gr: 5900,
      stawka_vat: '23',
      marka: 'Pracownia Półcień',
      kategoria_glowna: 'Lampy stołowe',
      szerokosc_mm: 255,
      opis_sekcje_json: JSON.stringify({
        sekcje: [{ elementy: [{ typ: 'tekst', html: '<p>Lampa z mlecznym kloszem.</p>' }] }],
      }),
    },
    { at: new Date(T0).toISOString() },
  );
  db.prepare('UPDATE karty_produktow SET informacja_bezpieczenstwa = ?, ean = ? WHERE id = ?').run(
    BEZPIECZENSTWO,
    eanDemo(1),
    id,
  );
  const zdj =
    db.prepare(`INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, adres_zrodlowy, sha256, typ, ai, ai_reczne, utworzono_at)
    VALUES (?, ?, 'reczne', ?, NULL, 'image/jpeg', 0, 1, ?)`);
  for (let i = 0; i < n; i++)
    zdj.run(id, i, `https://polcien.example.invalid/gliwka-${id}-${i + 1}.jpg`, new Date(T0).toISOString());
  // Opis kategorii 257 (wersja 2) w pamięci konta — ten sam zapis, co `opisKategoriiAllegro` po pobraniu.
  const opis = opisKategorii(['5', '256', '257'].map(kategoriaAllegroDemo), parametryKategoriiAllegroDemo('257'));
  db.prepare(
    `INSERT OR IGNORE INTO kanaly_kategorie (polaczenie, kategoria_id, sciezka_json, parametry_json, pobrano_at) VALUES (?, '257', ?, ?, ?)`,
  ).run(
    konto,
    JSON.stringify(opis.sciezka),
    JSON.stringify({
      wersja: opis.wersja,
      lisc: opis.lisc,
      tworzenieProduktu: opis.tworzenieProduktu,
      parametry: opis.parametry,
    }),
    new Date(T0).toISOString(),
  );
  db.prepare(
    `INSERT OR IGNORE INTO allegro_mapa_kategorii (kategoria_karty, srodowisko, kategoria_allegro_id) VALUES ('Lampy stołowe', 'produkcja', '257')`,
  ).run();
  const regula =
    db.prepare(`INSERT OR IGNORE INTO allegro_reguly_parametrow (srodowisko, kategoria_allegro_id, parametr_id, rodzaj,
    wartosc_json, pole, zmieniono_at) VALUES ('produkcja', '257', ?, ?, ?, ?, ?)`);
  regula.run('11323', 'stala', JSON.stringify({ valuesIds: ['11323_1'] }), null, new Date(T0).toISOString());
  regula.run('248811', 'pole', null, 'marka', new Date(T0).toISOString());
  db.prepare(
    `INSERT OR IGNORE INTO allegro_marki (marka, srodowisko, parametr_id, wartosc_id, kategorie_sprawdzone_json, zmieniono_at)
    VALUES ('Pracownia Półcień', 'produkcja', '248811', '248811_9001', '["257"]', ?)`,
  ).run(new Date(T0).toISOString());
  db.prepare(
    `INSERT OR IGNORE INTO allegro_marki_gpsr (marka, konto, zrodlo, zmieniono_at) VALUES ('Pracownia Półcień', ?, 'konto', ?)`,
  ).run(konto, new Date(T0).toISOString());
  const wiersz = wstawOferte(
    db,
    {
      kartaId: id,
      kanal: konto,
      idZewnetrzne: `ext:${znakInstalacji(db)}-K${id}`,
      tryb: 'zarzadzana',
      stan: 'do_wyslania',
    },
    { teraz: new Date(T0).toISOString() },
  );
  return { kartaId: id, ofertaId: wiersz.id };
}

/** Atrapa + prawdziwy rejestr kanałów + prawdziwy klient + baza OMS. `awaria(metoda, sciezka)` wstrzykuje usterki. */
function srodowisko({ ustawienia = {}, zgoda = true, tylkoOdczyt = () => false } = {}) {
  let czas = T0;
  const teraz = () => new Date(czas);
  const f = fixtureAllegro();
  const s = f.szkic();
  const k = daneAllegro(
    f.repo.zapiszZmiane(s.klucz, s.wersja, { autoryzacja: 'polaczone', kontoId: '123' }, aktorAllegro),
  );
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
      try {
        ciala.push({ zdarzenie: `${metoda} ${sciezka}`, cialo: JSON.parse(init.body) });
      } catch {
        /* ciało nie-JSON */
      }
    }
    const a = st.awaria?.(metoda, sciezka, adres);
    if (a === 'zgubiona-odpowiedz') {
      await serwer.fetchImpl(url, init);
      return zawies(init.signal);
    }
    if (a === 'bez-dotarcia') return zawies(init.signal);
    if (a instanceof Response) return a;
    return serwer.fetchImpl(url, init);
  }
  const rejestr = createRejestrKanalow({
    repozytorium: f.repo,
    fetchImpl,
    limitCzasuMs: 200,
    teraz,
    fabryki: ({ http }) => ({
      klient: createAllegroClient({
        ustawienia: { api: API_ATRAPY_ALLEGRO, userAgent: 'test/1 (+https://x.invalid)' },
        tokeny: { waznyToken: async () => 'token-atrapy-e308a' },
        http,
      }),
      poller: { stan: () => null, przebieg: async () => {} },
    }),
  });
  const klient = rejestr.klient(KONTO);
  const db = openOmsDb(':memory:', { moduly: modulyDla(ENV_DEMO) });
  sprzatanie.push(() => {
    db.close();
    dbAtrapy.close();
    f.db.close();
  });
  zapiszUstawieniaOfertKonta(
    db,
    KONTO,
    {
      czynne: true,
      aktywujPoSprawdzeniu: true,
      narzutProcent: 0,
      stalaIlosc: 5,
      czasWysylkiDni: 2,
      cennikDostaw: 'cennik-1',
      stawkaVat: '23',
      zwrotyId: 'zwrot-1',
      reklamacjeId: 'rekl-1',
      producentId: 'prod-konta',
      ...ustawienia,
    },
    { teraz: new Date(T0).toISOString() },
  );
  const konto = {
    klucz: KONTO,
    nazwa: 'Półcień Allegro',
    srodowisko: 'produkcja',
    zgoda,
    tylkoOdczyt,
    katalog: katalogAllegro(klient),
    allegro: wezlyAllegro(klient),
  };
  const petla = () =>
    createPetlaOfertAllegro({
      db,
      konta: () => [konto],
      teraz,
      zwolnijOperacje: (klucz, metoda, zasob) => f.repo.zwolnijOperacje(klucz, metoda, zasob),
      czytajZdjecie: async (z) => new Uint8Array([7, z.id, z.kolejnosc + 1]),
    });
  const przesun = (ms) => {
    czas += ms;
    f.setCzas(new Date(czas).toISOString());
  };
  const ile = (wzor) => zdarzenia.filter((z) => wzor.test(z)).length;
  const ofertyAtrapy = (ext) =>
    dbAtrapy
      .prepare('SELECT dane_json FROM atrapa_allegro_oferty WHERE kanal = ?')
      .all(KONTO)
      .map((w) => JSON.parse(w.dane_json))
      .filter((o) => o.external?.id === ext);
  const wstawDoAtrapy = (o) =>
    dbAtrapy
      .prepare('INSERT INTO atrapa_allegro_oferty (kanal, id, dane_json) VALUES (?, ?, ?)')
      .run(KONTO, String(o.id), JSON.stringify(o));
  const ofertaWAtrapie = (id) =>
    JSON.parse(
      dbAtrapy.prepare('SELECT dane_json FROM atrapa_allegro_oferty WHERE kanal = ? AND id = ?').get(KONTO, String(id))
        .dane_json,
    );
  const zmienWAtrapie = (id, f) =>
    dbAtrapy
      .prepare('UPDATE atrapa_allegro_oferty SET dane_json = ? WHERE kanal = ? AND id = ?')
      .run(JSON.stringify(f(ofertaWAtrapie(id))), KONTO, String(id));
  return {
    db,
    f,
    KONTO,
    st,
    zdarzenia,
    ciala,
    petla,
    przesun,
    ile,
    ofertyAtrapy,
    wstawDoAtrapy,
    ofertaWAtrapie,
    zmienWAtrapie,
    teraz,
    konto,
  };
}

const POST = /^POST \/sale\/product-offers$/;
const PATCH = /^PATCH \/sale\/product-offers\//;
const ext = (o) => o.wyslanePola.externalId;

/** Przebiegi co `krok` aż do stanu końcowego (najwyżej `n`). */
async function doKonca(e, p, ofertaId, { krok = 6000, n = 8 } = {}) {
  for (let i = 0; i < n && ['do_wyslania', 'wyslana', 'sprawdzana'].includes(ofertaPoId(e.db, ofertaId).stan); i++) {
    e.przesun(krok);
    await p.przebieg();
  }
  return ofertaPoId(e.db, ofertaId);
}

describe('E3.08a — pętla wysyłki ofert Allegro', () => {
  it('202→202→303 → aktywna; odczyt operacji nie szybciej niż co 5 s mimo Retry-After 1', async () => {
    const e = srodowisko();
    const { ofertaId } = karta(e.db, e.KONTO);
    const p = e.petla();
    await p.przebieg();
    let o = ofertaPoId(e.db, ofertaId);
    expect(o.stan).toBe('sprawdzana');
    expect(e.ile(POST)).toBe(1);
    expect(e.ile(PATCH)).toBe(1);
    expect(e.ile(/^GET \/sale\/products$/)).toBe(1);
    expect(e.ile(/^POST \/sale\/images$/)).toBe(2);
    expect(o.idZewnetrzne).toMatch(/^\d+$/);
    expect(ext(o)).toBe(`${znakInstalacji(e.db)}-K${o.kartaId}`);
    const przed = e.zdarzenia.length;
    e.przesun(1000);
    await p.przebieg();
    expect(e.zdarzenia.length).toBe(przed);
    e.przesun(5000);
    await p.przebieg();
    expect(e.ile(/\/operations\//)).toBe(1);
    expect(ofertaPoId(e.db, ofertaId).stan).toBe('sprawdzana');
    o = await doKonca(e, p, ofertaId);
    expect(o.stan).toBe('aktywna');
    expect(e.ile(/\/operations\//)).toBe(2);
    expect(e.ile(POST)).toBe(1);
    expect(e.ile(PATCH)).toBe(1);
  });

  it('restart po zapisie wiersza (odpowiedź zgubiona) → 0 duplikatów i 0 zgubionych', async () => {
    const e = srodowisko();
    const { ofertaId } = karta(e.db, e.KONTO);
    let raz = true;
    e.st.awaria = (m, s) =>
      m === 'POST' && s === '/sale/product-offers' && raz ? ((raz = false), 'zgubiona-odpowiedz') : null;
    await e.petla().przebieg();
    let o = ofertaPoId(e.db, ofertaId);
    expect(o.stan).toBe('wyslana');
    expect(o.idZewnetrzne).toBe(`ext:${ext(o)}`);
    expect(e.f.repo.niejednoznaczne(e.KONTO).length).toBeGreaterThan(0);
    // restart: nowa instancja pętli na tej samej bazie
    const p2 = e.petla();
    e.przesun(MIN);
    await p2.przebieg();
    o = await doKonca(e, p2, ofertaId);
    expect(o.stan).toBe('aktywna');
    expect(e.ofertyAtrapy(ext(o))).toHaveLength(1);
    expect(o.idZewnetrzne).toBe(String(e.ofertyAtrapy(ext(o))[0].id));
    expect(e.ile(POST)).toBe(1);
  });

  it('dwie oferty z tą samą sygnaturą → problem duplikat, bez POST', async () => {
    const e = srodowisko();
    const { ofertaId } = karta(e.db, e.KONTO);
    e.st.awaria = (m, s) => (m === 'POST' && s === '/sale/product-offers' ? 'bez-dotarcia' : null);
    await e.petla().przebieg();
    const o = ofertaPoId(e.db, ofertaId);
    for (const id of ['18999000001', '18999000002']) {
      e.wstawDoAtrapy({ id, name: o.wyslanePola.nazwa, external: { id: ext(o) }, publication: { status: 'INACTIVE' } });
    }
    e.st.awaria = null;
    e.przesun(MIN);
    await e.petla().przebieg();
    const po = ofertaPoId(e.db, ofertaId);
    expect(po.stan).toBe('problem');
    expect(po.problemy.map((x) => x.kod)).toContain('duplikat');
    expect(e.ile(POST)).toBe(1);
  });

  it('zakończona (ENDED) oferta z tą samą sygnaturą i nazwą nie jest nasza → ponowny POST po dwóch odczytach', async () => {
    const e = srodowisko();
    const { ofertaId } = karta(e.db, e.KONTO);
    e.st.awaria = (m, s) => (m === 'POST' && s === '/sale/product-offers' ? 'bez-dotarcia' : null);
    await e.petla().przebieg();
    const o = ofertaPoId(e.db, ofertaId);
    e.wstawDoAtrapy({
      id: '18999000009',
      name: o.wyslanePola.nazwa,
      external: { id: ext(o) },
      publication: { status: 'ENDED' },
    });
    e.st.awaria = null;
    const p = e.petla();
    e.przesun(MIN);
    await p.przebieg();
    expect(ofertaPoId(e.db, ofertaId).idZewnetrzne).toBe(`ext:${ext(o)}`);
    e.przesun(15 * MIN);
    await p.przebieg();
    const po = await doKonca(e, p, ofertaId);
    expect(po.idZewnetrzne).not.toBe('18999000009');
    expect(po.stan).toBe('aktywna');
    expect(e.ile(POST)).toBe(2);
  });

  it('bez POST przed drugim odczytem po 15 min; potem jeden ponowny POST i zwolniona operacja', async () => {
    const e = srodowisko();
    const { ofertaId } = karta(e.db, e.KONTO);
    e.st.awaria = (m, s) => (m === 'POST' && s === '/sale/product-offers' ? 'bez-dotarcia' : null);
    await e.petla().przebieg();
    e.st.awaria = null;
    const p = e.petla();
    e.przesun(MIN);
    await p.przebieg();
    e.przesun(10 * MIN);
    await p.przebieg();
    expect(e.ile(POST)).toBe(1);
    expect(e.ile(/^GET \/sale\/offers$/)).toBe(2);
    expect(ofertaPoId(e.db, ofertaId).stan).toBe('wyslana');
    e.przesun(5 * MIN);
    await p.przebieg();
    expect(e.ile(POST)).toBe(2);
    const o = await doKonca(e, p, ofertaId);
    expect(o.stan).toBe('aktywna');
    expect(e.ofertyAtrapy(ext(o))).toHaveLength(1);
  });

  it('po odzysku po sygnaturze wiersz z numerem ustawiony na do_wyslania wraca do synchronizacji bez drugiego POST (E3.34)', async () => {
    const e = srodowisko();
    const { ofertaId } = karta(e.db, e.KONTO);
    let raz = true;
    e.st.awaria = (m, s) =>
      m === 'POST' && s === '/sale/product-offers' && raz ? ((raz = false), 'zgubiona-odpowiedz') : null;
    const p = e.petla();
    await p.przebieg();
    e.przesun(MIN);
    await p.przebieg();
    expect(ofertaPoId(e.db, ofertaId).idZewnetrzne).toMatch(/^\d+$/);
    expect(e.f.repo.niejednoznaczne(e.KONTO)).toEqual([]);
    // Ktoś ustawia wiersz z numerem na do_wyslania (Ponów, D34).
    zmienOferte(
      e.db,
      ofertaId,
      { stan: 'do_wyslania', nastepnaProbaAt: null, blad: null },
      { teraz: e.teraz().toISOString() },
    );
    e.przesun(MIN);
    await p.przebieg();
    const o = ofertaPoId(e.db, ofertaId);
    expect(o.blad).toBeNull();
    // Numer Allegro nigdy nie idzie ponownie POST-em — tylko odczyt i ewentualnie Wznów.
    expect(e.ile(POST)).toBe(1);
    expect(o.stan).toBe('sprawdzana');
  });

  it('validation.errors → problem walidacja, bez PATCH', async () => {
    const e = srodowisko();
    const { ofertaId } = karta(e.db, e.KONTO, { nazwa: 'Lampa Gliwka [błąd]' });
    await e.petla().przebieg();
    const o = ofertaPoId(e.db, ofertaId);
    expect(o.stan).toBe('problem');
    expect(o.problemy.map((x) => x.kod)).toContain('walidacja');
    expect(e.ile(PATCH)).toBe(0);
  });

  it('aktywuj po sprawdzeniu = 0 → nieaktywna + szkic, bez PATCH', async () => {
    const e = srodowisko({ ustawienia: { aktywujPoSprawdzeniu: false } });
    const { ofertaId } = karta(e.db, e.KONTO);
    await e.petla().przebieg();
    const o = ofertaPoId(e.db, ofertaId);
    expect(o.stan).toBe('nieaktywna');
    expect(o.wyslanePola.szkic).toBe(true);
    expect(e.ile(PATCH)).toBe(0);
  });

  it('galeria: po wgraniu i błędzie oferty znacznik AI jest zablokowany, ponowienie bierze adresy z mapy', async () => {
    const e = srodowisko();
    const { ofertaId, kartaId } = karta(e.db, e.KONTO);
    e.st.awaria = (m, s) =>
      m === 'POST' && s === '/sale/product-offers'
        ? new Response(JSON.stringify({ errors: [{ code: 'X', message: 'Zła kategoria' }] }), {
            status: 422,
            headers: { 'Content-Type': 'application/json' },
          })
        : null;
    await e.petla().przebieg();
    let o = ofertaPoId(e.db, ofertaId);
    expect(o.stan).toBe('blad');
    expect(o.blad).toMatch(/Zła kategoria/);
    expect(e.ile(/^POST \/sale\/images$/)).toBe(2);
    const zdjecie = e.db
      .prepare('SELECT id FROM zdjecia_kart WHERE karta_id = ? ORDER BY kolejnosc LIMIT 1')
      .get(kartaId);
    expect(() =>
      ustawZnacznikAi(e.db, { kartaId, zdjecieId: zdjecie.id, ai: 1, at: e.teraz().toISOString() }),
    ).toThrow();
    e.st.awaria = null;
    zmienOferte(e.db, ofertaId, { stan: 'do_wyslania', nastepnaProbaAt: null }, { teraz: e.teraz().toISOString() });
    e.przesun(MIN);
    await e.petla().przebieg();
    o = ofertaPoId(e.db, ofertaId);
    expect(o.stan).toBe('sprawdzana');
    expect(e.ile(/^POST \/sale\/images$/)).toBe(2);
  });

  it('wstrzymane (czynne=false) albo tylko odczyt → 0 zapisów', async () => {
    for (const opcje of [{ ustawienia: { czynne: false } }, { tylkoOdczyt: () => true }]) {
      const e = srodowisko(opcje);
      const { ofertaId } = karta(e.db, e.KONTO);
      await e.petla().przebieg();
      expect(e.zdarzenia.filter((z) => !z.startsWith('GET '))).toEqual([]);
      expect(ofertaPoId(e.db, ofertaId).stan).toBe('do_wyslania');
    }
  });

  it('brak zgody → 0 wywołań', async () => {
    const e = srodowisko({ zgoda: false });
    const { ofertaId } = karta(e.db, e.KONTO);
    await e.petla().przebieg();
    expect(e.zdarzenia).toEqual([]);
    expect(ofertaPoId(e.db, ofertaId).stan).toBe('do_wyslania');
  });

  it('26 kart → 25 wysłanych w jednym przebiegu', async () => {
    const e = srodowisko({ ustawienia: { aktywujPoSprawdzeniu: false } });
    const id = [];
    for (let i = 0; i < 26; i++)
      id.push(karta(e.db, e.KONTO, { nazwa: `Lampa stołowa Gliwka ${i + 1}`, n: 1 }).ofertaId);
    await e.petla().przebieg();
    expect(e.ile(POST)).toBe(25);
    expect(id.filter((x) => ofertaPoId(e.db, x).stan === 'do_wyslania')).toHaveLength(1);
  });
  const POST_OFERTY = (m, s) => m === 'POST' && s === '/sale/product-offers';
  const jsonOdp = (status, cialo, naglowki = {}) =>
    new Response(JSON.stringify(cialo), { status, headers: { 'Content-Type': 'application/json', ...naglowki } });
  /** Pierwszy POST oferty nie dociera (limit czasu), potem odzysk po sygnaturze. */
  function pierwszyPostGinie(e, dalej = () => null) {
    let raz = true;
    e.st.awaria = (m, s) => (POST_OFERTY(m, s) && raz ? ((raz = false), 'bez-dotarcia') : dalej(m, s));
  }

  it('503 na POST → zostaje wyslana (wynik nieznany), nie blad', async () => {
    const e = srodowisko();
    const { ofertaId } = karta(e.db, e.KONTO);
    e.st.awaria = (m, s) => (POST_OFERTY(m, s) ? jsonOdp(503, {}) : null);
    await e.petla().przebieg();
    expect(ofertaPoId(e.db, ofertaId).stan).toBe('wyslana');
    expect(e.ile(POST)).toBe(1);
  });

  it('429 na POST → do_wyslania z terminem, bez operacji niejednoznacznej; potem zwykły POST', async () => {
    const e = srodowisko();
    const { ofertaId } = karta(e.db, e.KONTO);
    let raz = true;
    e.st.awaria = (m, s) =>
      POST_OFERTY(m, s) && raz ? ((raz = false), jsonOdp(429, {}, { 'Retry-After': '7' })) : null;
    const p = e.petla();
    await p.przebieg();
    const o = ofertaPoId(e.db, ofertaId);
    expect(o.stan).toBe('do_wyslania');
    expect(Date.parse(o.nastepnaProbaAt)).toBeGreaterThan(e.teraz().getTime());
    expect(e.f.repo.niejednoznaczne(e.KONTO)).toEqual([]);
    e.przesun(10_000);
    await p.przebieg();
    expect(e.ile(POST)).toBe(2);
    expect(ofertaPoId(e.db, ofertaId).stan).toBe('sprawdzana');
  });

  it('odzysk: oferta z naszą sygnaturą, ale jej numer ma inny wiersz → nie nasza; po 15 min ponowny POST', async () => {
    const e = srodowisko();
    const { kartaId, ofertaId } = karta(e.db, e.KONTO);
    pierwszyPostGinie(e);
    const p = e.petla();
    await p.przebieg();
    expect(ofertaPoId(e.db, ofertaId).stan).toBe('wyslana');
    const nazwa = ofertaPoId(e.db, ofertaId).wyslanePola.nazwa;
    e.wstawDoAtrapy({
      id: '18999000077',
      name: nazwa,
      external: { id: `${znakInstalacji(e.db)}-K${kartaId}` },
      publication: { status: 'INACTIVE' },
    });
    const inna = karta(e.db, e.KONTO, { nazwa: 'Lampa podłogowa Smuga', n: 1 });
    e.db
      .prepare("UPDATE oferty_kanalow SET id_zewnetrzne = '18999000077', stan = 'aktywna' WHERE id = ?")
      .run(inna.ofertaId);
    e.przesun(60_000);
    await p.przebieg();
    e.przesun(15 * 60_000);
    await p.przebieg();
    expect(e.ile(POST)).toBe(2);
    expect(ofertaPoId(e.db, ofertaId).idZewnetrzne).not.toBe('18999000077');
  });

  it('odzysk: ta sama sygnatura, inna nazwa → nie nasza; po 15 min ponowny POST', async () => {
    const e = srodowisko();
    const { kartaId, ofertaId } = karta(e.db, e.KONTO);
    pierwszyPostGinie(e);
    const p = e.petla();
    await p.przebieg();
    e.wstawDoAtrapy({
      id: '18999000078',
      name: 'Zupełnie inna lampa',
      external: { id: `${znakInstalacji(e.db)}-K${kartaId}` },
      publication: { status: 'INACTIVE' },
    });
    e.przesun(60_000);
    await p.przebieg();
    e.przesun(15 * 60_000);
    await p.przebieg();
    expect(e.ile(POST)).toBe(2);
    expect(ofertaPoId(e.db, ofertaId).idZewnetrzne).not.toBe('18999000078');
  });

  it('lista po sygnaturze niefiltrowana → nie wiadomo: bez odzysku i bez ponownego POST', async () => {
    const e = srodowisko();
    const { ofertaId } = karta(e.db, e.KONTO);
    pierwszyPostGinie(e, (m, s) =>
      m === 'GET' && s === '/sale/offers'
        ? jsonOdp(200, {
            offers: [
              {
                id: '17000000000999',
                name: 'Obca',
                external: { id: 'obca-sygnatura' },
                publication: { status: 'ACTIVE' },
              },
            ],
            count: 1,
            totalCount: 1,
          })
        : null,
    );
    const p = e.petla();
    await p.przebieg();
    for (const ms of [60_000, 16 * 60_000, 16 * 60_000]) {
      e.przesun(ms);
      await p.przebieg();
    }
    const o = ofertaPoId(e.db, ofertaId);
    expect(e.ile(/^GET \/sale\/offers$/)).toBeGreaterThan(1);
    expect(e.ile(POST)).toBe(1);
    expect(o.stan).toBe('wyslana');
    expect(o.wyslanePola.odzyskOd).toBeNull();
  });

  it('operacja w toku dłużej niż 3 h → problem bez-potwierdzenia (po 2 h jeszcze czeka)', async () => {
    const e = srodowisko();
    const { ofertaId } = karta(e.db, e.KONTO);
    e.st.awaria = (m, s) =>
      m === 'GET' && /\/operations\//.test(s)
        ? new Response(null, { status: 202, headers: { 'Retry-After': '1' } })
        : null;
    const p = e.petla();
    await p.przebieg();
    expect(ofertaPoId(e.db, ofertaId).stan).toBe('sprawdzana');
    e.przesun(2 * 3_600_000);
    await p.przebieg();
    expect(ofertaPoId(e.db, ofertaId).stan).toBe('sprawdzana');
    e.przesun(3_600_000);
    await p.przebieg();
    const o = ofertaPoId(e.db, ofertaId);
    expect(o.stan).toBe('problem');
    expect(o.problemy).toEqual([{ kod: 'bez-potwierdzenia' }]);
  });

  it('bramka zamknięta między POST a PATCH (tylko odczyt) → bez PATCH', async () => {
    let zamknieta = false;
    const e = srodowisko({ tylkoOdczyt: () => zamknieta });
    const { ofertaId } = karta(e.db, e.KONTO);
    e.st.awaria = (m, s) => {
      if (POST_OFERTY(m, s)) zamknieta = true;
      return null;
    };
    await e.petla().przebieg();
    expect(e.ile(POST)).toBe(1);
    expect(e.ile(PATCH)).toBe(0);
    expect(ofertaPoId(e.db, ofertaId).stan).toBe('sprawdzana');
  });

  it('422 PARAMETER_MISMATCH na POST → problem parameter-mismatch z productId i parameterId (D34 krok 4)', async () => {
    const e = srodowisko();
    const { ofertaId } = karta(e.db, e.KONTO);
    e.st.awaria = (m, s) =>
      POST_OFERTY(m, s)
        ? jsonOdp(422, {
            errors: [
              {
                code: 'PARAMETER_MISMATCH',
                message: 'Wartość parametru różni się od produktu',
                metadata: { productId: 'prod-77', parameterId: '224017' },
              },
            ],
          })
        : null;
    await e.petla().przebieg();
    const o = ofertaPoId(e.db, ofertaId);
    expect(o.stan).toBe('problem');
    expect(o.problemy).toEqual([{ kod: 'parameter-mismatch', produktId: 'prod-77', parametr: '224017' }]);
  });

  it('kilka produktów z EAN karty → problem wiele-produktow z ean, bez POST', async () => {
    const e = srodowisko();
    const { ofertaId } = karta(e.db, e.KONTO);
    e.st.awaria = (m, s) =>
      m === 'GET' && s === '/sale/products'
        ? jsonOdp(200, {
            products: [
              { id: 'p-1', name: 'Lampa A' },
              { id: 'p-2', name: 'Lampa B' },
            ],
          })
        : null;
    await e.petla().przebieg();
    const o = ofertaPoId(e.db, ofertaId);
    expect(o.stan).toBe('problem');
    expect(o.problemy).toEqual([
      {
        kod: 'wiele-produktow',
        produkty: [
          { id: 'p-1', nazwa: 'Lampa A', ean: String(eanDemo(1)) },
          { id: 'p-2', nazwa: 'Lampa B', ean: String(eanDemo(1)) },
        ],
      },
    ]);
    expect(e.ile(POST)).toBe(0);
  });
});

// Synchronizacja (odczyt ofert konta, komendy ilości i ceny, treść) i aktywacja szkicu.
describe('E3.08b — synchronizacja i aktywacja', () => {
  const PUT_ILOSCI = /^PUT \/sale\/offer-quantity-change-commands\//;
  const PUT_CENY = /^PUT \/sale\/offer-price-change-commands\//;
  const TASKS_ILOSCI = /^GET \/sale\/offer-quantity-change-commands\/[^/]+\/tasks$/;
  const LISTA = /^GET \/sale\/offers$/;
  const ZAPISY = /^(PUT|PATCH) /;
  const cialaPo = (e, wzor, od = 0) => e.ciala.slice(od).filter((c) => wzor.test(c.zdarzenie));
  const STAN_NOWY = { id: '11323', valuesIds: ['11323_1'] };

  /** Karta przechodzi całe wystawienie (aktywna albo szkic). */
  async function wystawiona(e, opcje) {
    const k = karta(e.db, e.KONTO, opcje);
    const p = e.petla();
    const o = await doKonca(e, p, k.ofertaId);
    return { ...k, p, o };
  }
  const ustawPola = (e, id, zmiany) => {
    const o = ofertaPoId(e.db, id);
    zmienOferte(e.db, id, { wyslanePola: { ...o.wyslanePola, ...zmiany } }, { teraz: e.teraz().toISOString() });
  };
  const przebieg = async (e, p, ms = MIN) => {
    e.przesun(ms);
    await p.przebieg();
  };

  it('aktywacja szkicu → PATCH ACTIVE → aktywna, zdjęte szkic i aktywuj', async () => {
    const e = srodowisko({ ustawienia: { aktywujPoSprawdzeniu: false } });
    const { ofertaId, p, o } = await wystawiona(e);
    expect(o.stan).toBe('nieaktywna');
    expect(o.wyslanePola.szkic).toBe(true);
    expect(e.ile(PATCH)).toBe(0);
    ustawPola(e, ofertaId, { aktywuj: true });
    await przebieg(e, p, 1000);
    expect(cialaPo(e, PATCH).map((c) => c.cialo)).toEqual([{ publication: { status: 'ACTIVE' } }]);
    expect(ofertaPoId(e.db, ofertaId).stan).toBe('sprawdzana');
    const po = await doKonca(e, p, ofertaId);
    expect(po.stan).toBe('aktywna');
    expect(po.wyslanePola.szkic).toBeUndefined();
    expect(po.wyslanePola.aktywuj).toBeUndefined();
    expect(e.ofertaWAtrapie(po.idZewnetrzne).publication.status).toBe('ACTIVE');
    await przebieg(e, p);
    expect(e.ile(PATCH)).toBe(1);
  });

  it('aktywacja z 422 duplikatu → problem aktywacja z tekstem Allegro, aktywuj zdjęte, bez ponowienia', async () => {
    const e = srodowisko({ ustawienia: { aktywujPoSprawdzeniu: false } });
    const { ofertaId, p } = await wystawiona(e, { nazwa: 'Lampa stołowa Gliwka [duplikat]' });
    ustawPola(e, ofertaId, { aktywuj: true });
    await przebieg(e, p, 1000);
    const o = ofertaPoId(e.db, ofertaId);
    expect(o.stan).toBe('problem');
    expect(o.problemy).toEqual([{ kod: 'aktywacja', tekst: expect.stringContaining('duplikat') }]);
    expect(o.wyslanePola.aktywuj).toBeUndefined();
    await przebieg(e, p);
    expect(e.ile(PATCH)).toBe(1);
  });

  it('aktywuj na ofercie zdjętej (bez szkic) → nic do Allegro, aktywuj zdjęte (D30, D25)', async () => {
    const e = srodowisko();
    const { ofertaId, p, o } = await wystawiona(e);
    expect(o.stan).toBe('aktywna');
    ustawPola(e, ofertaId, { zdejmij: true });
    const przed = e.ciala.length;
    await przebieg(e, p, 1000);
    expect(cialaPo(e, PATCH, przed).map((c) => c.cialo)).toEqual([{ publication: { status: 'ENDED' } }]);
    const zdjeta = await doKonca(e, p, ofertaId);
    expect(zdjeta.stan).toBe('nieaktywna');
    expect(zdjeta.wyslanePola.wycofanoAt).toEqual(expect.any(String));
    expect(e.ofertaWAtrapie(o.idZewnetrzne).publication.status).toBe('ENDED');
    // Po zdjęciu ilości się nie przywraca.
    e.zmienWAtrapie(o.idZewnetrzne, (x) => ({ ...x, stock: { ...x.stock, available: 2 } }));
    ustawPola(e, ofertaId, { aktywuj: true });
    const przed2 = e.ciala.length;
    await przebieg(e, p);
    expect(cialaPo(e, ZAPISY, przed2)).toEqual([]);
    const po = ofertaPoId(e.db, ofertaId);
    expect(po.wyslanePola.aktywuj).toBeUndefined();
    expect(po.stan).toBe('nieaktywna');
    expect(po.odczytIlosc).toBe(2);
  });

  it('wycofana karta → PATCH ENDED → nieaktywna, potem cisza', async () => {
    const e = srodowisko();
    const { ofertaId, kartaId, p } = await wystawiona(e);
    e.db.prepare('UPDATE karty_produktow SET wycofana = 1 WHERE id = ?').run(kartaId);
    const przed = e.ciala.length;
    const po = await (async () => {
      await przebieg(e, p, 1000);
      return doKonca(e, p, ofertaId);
    })();
    expect(cialaPo(e, PATCH, przed).map((c) => c.cialo)).toEqual([{ publication: { status: 'ENDED' } }]);
    expect(po.stan).toBe('nieaktywna');
    const przed2 = e.ciala.length;
    await przebieg(e, p);
    expect(cialaPo(e, ZAPISY, przed2)).toEqual([]);
  });

  it('po aktywacji kolejne przebiegi: odczyt przy wierszu, 0 PATCH i 0 komend (skrót treści zgodny)', async () => {
    const e = srodowisko();
    const { ofertaId, p, o } = await wystawiona(e);
    expect(o.stan).toBe('aktywna');
    const zapisy = e.ile(/^(PUT|PATCH) /);
    await przebieg(e, p);
    await przebieg(e, p);
    expect(e.ile(/^(PUT|PATCH) /)).toBe(zapisy);
    expect(e.ile(LISTA)).toBeGreaterThanOrEqual(2);
    const po = ofertaPoId(e.db, ofertaId);
    expect(po).toMatchObject({
      stan: 'aktywna',
      odczytIlosc: 5,
      odczytCenaGr: 5900,
      odczytStatus: 'ACTIVE',
      problemy: [],
    });
    expect(po.odczytanoAt).toBe(e.teraz().toISOString());
  });

  it('kupujący zdjął 2 sztuki → komenda ilości przywraca stałą (różnica względem odczytu)', async () => {
    const e = srodowisko();
    const { ofertaId, p, o } = await wystawiona(e);
    expect(o.wyslanaIlosc).toBe(5);
    e.zmienWAtrapie(o.idZewnetrzne, (x) => ({ ...x, stock: { ...x.stock, available: 3 } }));
    const przed = e.ciala.length;
    await przebieg(e, p);
    const put = cialaPo(e, PUT_ILOSCI, przed);
    expect(put).toHaveLength(1);
    expect(put[0].cialo).toEqual({
      modification: { changeType: 'FIXED', value: 5 },
      offerCriteria: [{ offers: [{ id: o.idZewnetrzne }], type: 'CONTAINS_OFFERS' }],
    });
    expect(e.ofertaWAtrapie(o.idZewnetrzne).stock.available).toBe(5);
    const po = ofertaPoId(e.db, ofertaId);
    expect(po.odczytIlosc).toBe(5);
    expect(po.wyslanaIlosc).toBe(5);
    expect(po.wyslanePola.komendaIlosci).toBeUndefined();
    await przebieg(e, p);
    expect(e.ile(PUT_ILOSCI)).toBe(1);
    expect(e.ile(PATCH)).toBe(1);
  });

  it('oferta obserwowana → tylko odczyt, bez komend', async () => {
    const e = srodowisko();
    const { ofertaId, p, o } = await wystawiona(e);
    e.db.prepare("UPDATE oferty_kanalow SET tryb = 'obserwowana' WHERE id = ?").run(ofertaId);
    e.zmienWAtrapie(o.idZewnetrzne, (x) => ({ ...x, stock: { ...x.stock, available: 3 } }));
    const przed = e.ciala.length;
    await przebieg(e, p);
    expect(cialaPo(e, ZAPISY, przed)).toEqual([]);
    expect(ofertaPoId(e.db, ofertaId).odczytIlosc).toBe(3);
  });

  it('zmiana ceny o 25% → czeka na potwierdzenie, nic nie wychodzi; po potwierdzeniu komenda ceny', async () => {
    const e = srodowisko();
    const { ofertaId, kartaId, p, o } = await wystawiona(e);
    e.db.prepare('UPDATE karty_produktow SET cena_gr = 7375 WHERE id = ?').run(kartaId);
    const przed = e.ciala.length;
    await przebieg(e, p);
    expect(cialaPo(e, ZAPISY, przed)).toEqual([]);
    let po = ofertaPoId(e.db, ofertaId);
    expect(po.cenaDoPotwierdzeniaGr).toBe(7375);
    expect(po.problemy).toEqual([{ kod: 'cena', tekst: expect.stringContaining('próg') }]);
    expect(po.stan).toBe('aktywna');
    ustawPola(e, ofertaId, { cenaPotwierdzonaGr: 7375 });
    await przebieg(e, p);
    const put = cialaPo(e, PUT_CENY, przed);
    expect(put).toHaveLength(1);
    expect(put[0].cialo.modification).toEqual({ type: 'FIXED_PRICE', price: { amount: '73.75', currency: 'PLN' } });
    expect(e.ofertaWAtrapie(o.idZewnetrzne).sellingMode.price.amount).toBe('73.75');
    po = ofertaPoId(e.db, ofertaId);
    expect(po).toMatchObject({ cenaDoPotwierdzeniaGr: null, problemy: [], wyslanaCenaGr: 7375, odczytCenaGr: 7375 });
  });

  it('T-M1: ręczna cena konta 105 zł → pętla liczy cel z ręcznej, po potwierdzeniu komenda ceny 105.00', async () => {
    const e = srodowisko();
    const { ofertaId, kartaId, p, o } = await wystawiona(e);
    expect(e.ofertaWAtrapie(o.idZewnetrzne).sellingMode.price.amount).toBe('59.00');
    ustawCeneReczna(e.db, {
      kartaId,
      kanal: e.KONTO,
      cenaGr: 10500,
      kto: 'administrator',
      at: e.teraz().toISOString(),
    });
    const przed = e.ciala.length;
    await przebieg(e, p);
    expect(cialaPo(e, ZAPISY, przed)).toEqual([]);
    expect(ofertaPoId(e.db, ofertaId).cenaDoPotwierdzeniaGr).toBe(10500);
    ustawPola(e, ofertaId, { cenaPotwierdzonaGr: 10500 });
    await przebieg(e, p);
    const put = cialaPo(e, PUT_CENY, przed);
    expect(put).toHaveLength(1);
    expect(put[0].cialo.modification).toEqual({ type: 'FIXED_PRICE', price: { amount: '105.00', currency: 'PLN' } });
    expect(e.ofertaWAtrapie(o.idZewnetrzne).sellingMode.price.amount).toBe('105.00');
    expect(ofertaPoId(e.db, ofertaId)).toMatchObject({ cenaDoPotwierdzeniaGr: null, wyslanaCenaGr: 10500 });
  });

  it('zmiana opisu → PATCH z kompletem: parameters ze „Stanem”, images, responsibleProducer i safetyInformation', async () => {
    const e = srodowisko();
    const { ofertaId, kartaId, p, o } = await wystawiona(e);
    e.db
      .prepare('UPDATE karty_produktow SET opis_sekcje_json = ? WHERE id = ?')
      .run(
        JSON.stringify({ sekcje: [{ elementy: [{ typ: 'tekst', html: '<p>Nowy klosz z dmuchanego szkła.</p>' }] }] }),
        kartaId,
      );
    const przed = e.ciala.length;
    await przebieg(e, p);
    const patch = cialaPo(e, PATCH, przed);
    expect(patch).toHaveLength(1);
    const c = patch[0].cialo;
    expect(c.parameters).toContainEqual(STAN_NOWY);
    expect(c.images).toHaveLength(2);
    expect(c.images.every((u) => typeof u === 'string' && !u.startsWith('oms-zdjecie:'))).toBe(true);
    expect(c.productSet[0].responsibleProducer).toEqual({ type: 'ID', id: 'prod-konta' });
    expect(c.productSet[0].safetyInformation).toEqual({
      type: 'TEXT',
      description: 'Nie zostawiaj włączonej lampy bez nadzoru.',
    });
    expect(JSON.stringify(c.description)).toContain('dmuchanego');
    expect(c.publication).toBeUndefined();
    expect(c.stock).toBeUndefined();
    expect(c.sellingMode).toBeUndefined();
    expect(c.category).toBeUndefined();
    expect(e.ile(/^POST \/sale\/images$/)).toBe(2);
    expect(JSON.stringify(e.ofertaWAtrapie(o.idZewnetrzne).description)).toContain('dmuchanego');
    await doKonca(e, p, ofertaId);
    await przebieg(e, p);
    expect(e.ile(PATCH)).toBe(2);
    expect(ofertaPoId(e.db, ofertaId).stan).toBe('aktywna');
  });

  it('GPSR z produktu katalogu (gpsrZProduktu) trafia do PATCH, gdy marka nie ma przypisania', async () => {
    const e = srodowisko();
    const { ofertaId, p } = await wystawiona(e);
    e.db.prepare('DELETE FROM allegro_marki_gpsr').run();
    ustawPola(e, ofertaId, {
      gpsrZProduktu: { responsibleProducer: { type: 'ID', id: 'prod-z-katalogu' }, responsiblePerson: null },
    });
    const przed = e.ciala.length;
    await przebieg(e, p);
    const patch = cialaPo(e, PATCH, przed);
    expect(patch).toHaveLength(1);
    expect(patch[0].cialo.productSet[0].responsibleProducer).toEqual({ type: 'ID', id: 'prod-z-katalogu' });
    expect(patch[0].cialo.productSet[0]).not.toHaveProperty('responsiblePerson');
  });

  // ENDED przy 0 sztukach wznawia się po prognozie 0 zł (D41) — testy w petla-ofert-allegro-pomiar.test.js.
  for (const sztuk of [3]) {
    it(`ENDED przy ${sztuk} sztukach (zakończona ręcznie) → problem zakonczona, bez wznawiania`, async () => {
      const e = srodowisko();
      const { ofertaId, p, o } = await wystawiona(e);
      e.zmienWAtrapie(o.idZewnetrzne, (x) => ({
        ...x,
        stock: { ...x.stock, available: sztuk },
        publication: { ...x.publication, status: 'ENDED' },
      }));
      const przed = e.ciala.length;
      await przebieg(e, p);
      await przebieg(e, p);
      expect(cialaPo(e, ZAPISY, przed)).toEqual([]);
      const po = ofertaPoId(e.db, ofertaId);
      expect(po.stan).toBe('problem');
      expect(po.problemy).toEqual([{ kod: 'zakonczona', sztuk }]);
      expect(po.odczytStatus).toBe('ENDED');
    });
  }

  it('timeout komendy ilości → przed nową komendą odczyt tasks, nowa komenda z nowym UUID', async () => {
    const e = srodowisko();
    const { ofertaId, p, o } = await wystawiona(e);
    e.zmienWAtrapie(o.idZewnetrzne, (x) => ({ ...x, stock: { ...x.stock, available: 3 } }));
    let raz = true;
    e.st.awaria = (m, s) => (m === 'PUT' && /quantity/.test(s) && raz ? ((raz = false), 'bez-dotarcia') : null);
    await przebieg(e, p);
    const pierwsza = ofertaPoId(e.db, ofertaId).wyslanePola.komendaIlosci;
    expect(pierwsza).toMatchObject({ id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    const przed = e.zdarzenia.length;
    await przebieg(e, p);
    const po = e.zdarzenia.slice(przed);
    const tasks = po.findIndex((z) => TASKS_ILOSCI.test(z));
    const put = po.findIndex((z) => PUT_ILOSCI.test(z));
    expect(tasks).toBeGreaterThanOrEqual(0);
    expect(put).toBeGreaterThan(tasks);
    expect(
      po.filter((z) => z.startsWith(`GET /sale/offer-quantity-change-commands/${pierwsza.id}/tasks`)),
    ).toHaveLength(1);
    const puty = e.zdarzenia.filter((z) => PUT_ILOSCI.test(z));
    expect(puty).toHaveLength(2);
    expect(puty[1]).not.toBe(puty[0]);
    expect(e.ofertaWAtrapie(o.idZewnetrzne).stock.available).toBe(5);
    expect(ofertaPoId(e.db, ofertaId).wyslanePola.komendaIlosci).toBeUndefined();
  });

  it('odrzucona komenda ilości (422) → kolejne PUT dopiero po przerwie, po 5 próbach problem komenda i cisza', async () => {
    const e = srodowisko();
    const { ofertaId, p, o } = await wystawiona(e);
    e.zmienWAtrapie(o.idZewnetrzne, (x) => ({ ...x, stock: { ...x.stock, available: 3 } }));
    e.st.awaria = (m, s) =>
      m === 'PUT' && /quantity/.test(s)
        ? new Response(
            JSON.stringify({ errors: [{ code: 'VALIDATION_ERROR', message: 'Ilość poza zakresem konta' }] }),
            { status: 422, headers: { 'Content-Type': 'application/json' } },
          )
        : null;
    await przebieg(e, p);
    let po = ofertaPoId(e.db, ofertaId);
    expect(e.ile(PUT_ILOSCI)).toBe(1);
    expect(po.liczbaProb).toBe(1);
    expect(po.nastepnaProbaAt).toEqual(expect.any(String));
    expect(po.wyslanePola.komendaIlosci).toBeUndefined();
    // Przerwy 30 s, 1, 2, 4 min — przebieg co minutę: 12 przebiegów to 5 PUT, nie 12.
    for (let i = 0; i < 11; i++) await przebieg(e, p);
    expect(e.ile(PUT_ILOSCI)).toBe(5);
    po = ofertaPoId(e.db, ofertaId);
    expect(po.stan).toBe('problem');
    expect(po.problemy).toEqual([{ kod: 'komenda', rodzaj: 'ilosc', tekst: expect.stringContaining('zakresem') }]);
    for (let i = 0; i < 3; i++) await przebieg(e, p, 10 * MIN);
    expect(e.ile(PUT_ILOSCI)).toBe(5);
  });

  it('problem komenda + wycofana karta → PATCH ENDED mimo problemu, oferta przestaje sprzedawać', async () => {
    const e = srodowisko();
    const { ofertaId, kartaId, p, o } = await wystawiona(e);
    zmienOferte(
      e.db,
      ofertaId,
      {
        stan: 'problem',
        nastepnaProbaAt: null,
        problemy: [{ kod: 'komenda', rodzaj: 'ilosc', tekst: 'Ilość poza zakresem konta' }],
      },
      { teraz: e.teraz().toISOString() },
    );
    e.db.prepare('UPDATE karty_produktow SET wycofana = 1 WHERE id = ?').run(kartaId);
    const przed = e.ciala.length;
    await przebieg(e, p, 1000);
    const po = await doKonca(e, p, ofertaId);
    expect(cialaPo(e, PATCH, przed).map((c) => c.cialo)).toEqual([{ publication: { status: 'ENDED' } }]);
    expect(e.ofertaWAtrapie(o.idZewnetrzne).publication.status).toBe('ENDED');
    expect(po.stan).toBe('nieaktywna');
  });

  it('komenda ilości z wynikiem FAIL w tasks → przerwy, po 5 próbach problem komenda i cisza', async () => {
    const e = srodowisko();
    const { ofertaId, p, o } = await wystawiona(e);
    e.st.awaria = (m, s) =>
      m === 'GET' && TASKS_ILOSCI.test(`GET ${s}`)
        ? new Response(
            JSON.stringify({
              tasks: [{ offer: { id: o.idZewnetrzne }, status: 'FAIL', message: 'Oferta zablokowana do zmian' }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        : null;
    // Atrapa przyjmuje PUT, więc przed każdym przebiegiem „kupujący” znów zostawia 3 sztuki.
    const trzy = () => e.zmienWAtrapie(o.idZewnetrzne, (x) => ({ ...x, stock: { ...x.stock, available: 3 } }));
    for (let i = 0; i < 12; i++) {
      trzy();
      await przebieg(e, p);
    }
    expect(e.ile(PUT_ILOSCI)).toBe(5);
    const po = ofertaPoId(e.db, ofertaId);
    expect(po.stan).toBe('problem');
    expect(po.problemy).toEqual([{ kod: 'komenda', rodzaj: 'ilosc', tekst: expect.stringContaining('zablokowana') }]);
    for (let i = 0; i < 3; i++) {
      trzy();
      await przebieg(e, p, 10 * MIN);
    }
    expect(e.ile(PUT_ILOSCI)).toBe(5);
  });

  it('komenda przyjęta (SUCCESS) zeruje licznik prób — kolejne odrzucenie nie daje od razu problemu', async () => {
    const e = srodowisko();
    const { ofertaId, p, o } = await wystawiona(e);
    zmienOferte(e.db, ofertaId, { liczbaProb: 4, nastepnaProbaAt: null }, { teraz: e.teraz().toISOString() });
    e.zmienWAtrapie(o.idZewnetrzne, (x) => ({ ...x, stock: { ...x.stock, available: 3 } }));
    await przebieg(e, p);
    expect(e.ile(PUT_ILOSCI)).toBe(1);
    expect(ofertaPoId(e.db, ofertaId).liczbaProb).toBe(0);
    e.zmienWAtrapie(o.idZewnetrzne, (x) => ({ ...x, stock: { ...x.stock, available: 2 } }));
    e.st.awaria = (m, s) =>
      m === 'PUT' && /quantity/.test(s)
        ? new Response(
            JSON.stringify({ errors: [{ code: 'VALIDATION_ERROR', message: 'Ilość poza zakresem konta' }] }),
            { status: 422, headers: { 'Content-Type': 'application/json' } },
          )
        : null;
    await przebieg(e, p);
    const po = ofertaPoId(e.db, ofertaId);
    expect(po.stan).toBe('aktywna');
    expect(po.liczbaProb).toBe(1);
  });

  it('PATCH ENDED z odpowiedzią ok:false (kanał bez metody) → przerwy jak przy błędzie, nie co przebieg', async () => {
    const e = srodowisko();
    const { ofertaId, kartaId, p } = await wystawiona(e);
    const oryg = e.konto.katalog.zmienOferte;
    let ended = 0;
    e.konto.katalog = {
      ...e.konto.katalog,
      zmienOferte: async (id, z) =>
        z?.publication?.status === 'ENDED'
          ? ((ended += 1), { ok: false, powod: 'kanał allegro: zmienOferte niezaimplementowane' })
          : oryg(id, z),
    };
    e.db.prepare('UPDATE karty_produktow SET wycofana = 1 WHERE id = ?').run(kartaId);
    // Przerwy 30 s, 1, 2, 4 min — przebieg co minutę: 8 przebiegów to 4 próby, nie 8.
    for (let i = 0; i < 8; i++) await przebieg(e, p);
    expect(ended).toBe(4);
    const po = ofertaPoId(e.db, ofertaId);
    // Próby zdejmowania mają własny licznik, niezależny od `liczbaProb` komend.
    expect(po.wyslanePola.probyZdjecia).toBe(4);
    expect(po.blad).toContain('niezaimplementowane');
    expect(po.stan).toBe('aktywna');
  });

  it('cena potwierdzona dla innej wartości niż nowa → dalej czeka na potwierdzenie, bez komendy ceny', async () => {
    const e = srodowisko();
    const { ofertaId, kartaId, p } = await wystawiona(e);
    e.db.prepare('UPDATE karty_produktow SET cena_gr = 7375 WHERE id = ?').run(kartaId);
    ustawPola(e, ofertaId, { cenaPotwierdzonaGr: 7000 });
    const przed = e.ciala.length;
    await przebieg(e, p);
    expect(cialaPo(e, PUT_CENY, przed)).toEqual([]);
    const po = ofertaPoId(e.db, ofertaId);
    expect(po.cenaDoPotwierdzeniaGr).toBe(7375);
    expect(po.problemy).toEqual([{ kod: 'cena', tekst: expect.stringContaining('próg') }]);
  });

  it('aktywuj na szkicu wycofanej karty → bez PATCH ACTIVE, aktywuj zdjęte', async () => {
    const e = srodowisko({ ustawienia: { aktywujPoSprawdzeniu: false } });
    const { ofertaId, kartaId, p, o } = await wystawiona(e);
    expect(o.wyslanePola.szkic).toBe(true);
    e.db.prepare('UPDATE karty_produktow SET wycofana = 1 WHERE id = ?').run(kartaId);
    ustawPola(e, ofertaId, { aktywuj: true });
    const przed = e.ciala.length;
    await przebieg(e, p, 1000);
    await przebieg(e, p);
    expect(cialaPo(e, PATCH, przed)).toEqual([]);
    const po = ofertaPoId(e.db, ofertaId);
    expect(po.wyslanePola.aktywuj).toBeUndefined();
    expect(po.stan).toBe('nieaktywna');
    expect(e.ofertaWAtrapie(o.idZewnetrzne).publication.status).not.toBe('ACTIVE');
  });

  it('zaległa komenda w toku (tasks NEW) → bez nowej komendy, UUID zostaje', async () => {
    const e = srodowisko();
    const { ofertaId, p, o } = await wystawiona(e);
    e.zmienWAtrapie(o.idZewnetrzne, (x) => ({ ...x, stock: { ...x.stock, available: 3 } }));
    let raz = true;
    e.st.awaria = (m, s) => (m === 'PUT' && /quantity/.test(s) && raz ? ((raz = false), 'bez-dotarcia') : null);
    await przebieg(e, p);
    const pierwsza = ofertaPoId(e.db, ofertaId).wyslanePola.komendaIlosci;
    expect(pierwsza).toMatchObject({ id: expect.any(String) });
    e.st.awaria = (m, s) =>
      m === 'GET' && TASKS_ILOSCI.test(`GET ${s}`)
        ? new Response(JSON.stringify({ tasks: [{ offer: { id: o.idZewnetrzne }, status: 'NEW' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        : null;
    await przebieg(e, p);
    await przebieg(e, p);
    expect(e.ile(PUT_ILOSCI)).toBe(1);
    expect(e.ile(TASKS_ILOSCI)).toBe(2);
    expect(ofertaPoId(e.db, ofertaId).wyslanePola.komendaIlosci).toEqual(pierwsza);
  });

  it('konto z 4500 ofertami → wszystkie strony po LIMIT_STRONY_OFERT bez wyjątku; naszej oferty brak → problem brak-w-allegro', async () => {
    const e = srodowisko();
    const { ofertaId, p } = await wystawiona(e);
    const RAZEM = 4500;
    e.st.awaria = (m, s, adres) => {
      if (m !== 'GET' || s !== '/sale/offers') return null;
      const offset = Number(adres.searchParams.get('offset') ?? 0);
      const limit = Number(adres.searchParams.get('limit') ?? 20);
      const offers = Array.from({ length: Math.max(0, Math.min(limit, RAZEM - offset)) }, (_x, i) => ({
        id: String(18000000000000 + offset + i),
        name: `Lampa wisząca nr ${offset + i}`,
        external: null,
        sellingMode: { price: { amount: '99.00', currency: 'PLN' } },
        stock: { available: 1, unit: 'UNIT' },
        publication: { status: 'ACTIVE' },
      }));
      return new Response(JSON.stringify({ offers, count: offers.length, totalCount: RAZEM }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const przed = e.zdarzenia.length;
    await przebieg(e, p);
    expect(e.zdarzenia.slice(przed).filter((z) => LISTA.test(z))).toHaveLength(Math.ceil(4500 / LIMIT_STRONY_OFERT));
    const po = ofertaPoId(e.db, ofertaId);
    expect(po.stan).toBe('problem');
    expect(po.problemy).toEqual([{ kod: 'brak-w-allegro' }]);
    expect(e.zdarzenia.slice(przed).filter((z) => ZAPISY.test(z))).toEqual([]);
  });
});
