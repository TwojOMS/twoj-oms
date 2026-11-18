// Ponawianie synchronizacji ofert: ceny, ilości, treść, wznowienie i odzysk po błędach.
// Baza OMS, rejestr i klient Allegro, serwer atrapy w pamięci. Bez sieci.
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
  ofertyDoDecyzji,
} from '../../../src/oms/db/oferty-kanalow.ts';
import { zmianyPonowienia } from '../../../src/moduly/magazyn/oferty.js';
import { znakInstalacji } from '../../../src/moduly/magazyn/services/oferty-wspolne.js';
import { createAllegroClient } from '../../../src/oms/allegro/client.js';
import { katalogAllegro, wezlyAllegro } from '../../../src/integracje/kanal-modul.ts';
import { createSerwerOfertAllegro, API_ATRAPY_ALLEGRO } from '../../../deploy/proba/atrapy/allegro-oferty.mjs';
import { fixtureAllegro, daneAllegro, aktorAllegro } from '../../pomoc/allegro-konfigurator.ts';
import { createRejestrKanalow } from '../../../src/moduly/kanaly/services/rejestr-kanalow.ts';
import { createPetlaOfertAllegro } from '../../../src/moduly/magazyn/services/petla-ofert-allegro.js';

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
    allegro: { ...wezlyAllegro(klient) },
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

const odczytaj = (e, k) => ofertaPoId(e.db, k.ofertaId);
const wycofaj = (e, k) => e.db.prepare('UPDATE karty_produktow SET wycofana = 1 WHERE id = ?').run(k.kartaId);
const patche = (e) => e.ciala.filter((x) => x.zdarzenie.startsWith('PATCH /sale/product-offers/')).map((x) => x.cialo);
async function krok(e, ms = MIN) {
  e.przesun(ms);
  await e.petla().przebieg();
}
async function czynna(e) {
  const k = karta(e.db, e.KONTO);
  for (let i = 0; i < 10 && odczytaj(e, k).stan !== 'aktywna'; i++) await krok(e);
  expect(odczytaj(e, k).stan).toBe('aktywna');
  e.ciala.length = 0;
  return k;
}
function sprawdzana(e, k, etap = 'tresc') {
  zmienOferte(e.db, k.ofertaId, {
    stan: 'sprawdzana',
    nastepnaProbaAt: null,
    wyslanePola: {
      ...odczytaj(e, k).wyslanePola,
      etap,
      operacja: '/operacja-testowa',
      operacjaOd: e.teraz().toISOString(),
    },
  });
}

describe('E3c odbiór pętli', () => {
  it('B2 aktywacja odrzucona 422 pozostaje problemem aktywacji po trzech przebiegach', async () => {
    const e = srodowisko();
    const k = karta(e.db, e.KONTO);
    const stanOperacji = e.konto.allegro.stanOperacji;
    e.konto.allegro.stanOperacji = async (...args) => {
      if (odczytaj(e, k).wyslanePola.etap === 'aktywacja') {
        e.zmienWAtrapie(odczytaj(e, k).idZewnetrzne, (o) => ({ ...o, publication: { status: 'INACTIVE' } }));
        throw Object.assign(new Error('Aktywacja odrzucona'), { status: 422 });
      }
      return stanOperacji(...args);
    };
    for (let i = 0; i < 3; i++) await krok(e, 5 * MIN);
    expect(patche(e).filter((x) => x.publication?.status === 'ACTIVE')).toHaveLength(1);
    expect(odczytaj(e, k)).toMatchObject({ stan: 'problem', problemy: [{ kod: 'aktywacja' }] });
  });
  it('B2 odrzucona treść jest widoczna w przerwie, ponawiana, a kolejne 422 wydłuża przerwę', async () => {
    const e = srodowisko();
    const k = await czynna(e);
    e.db
      .prepare('UPDATE karty_produktow SET nazwa = ? WHERE id = ?')
      .run('Lampa stołowa Gliwka z mlecznym kloszem', k.kartaId);
    const katalog = e.konto.katalog;
    e.konto.katalog = {
      ...katalog,
      zmienOferte: async (...args) => {
        const r = await katalog.zmienOferte(...args);
        return { ...r, dane: { ...r.dane, operacja: '/operacja-tresci', retryAfterS: 5 } };
      },
    };
    e.konto.allegro.stanOperacji = async () => {
      throw Object.assign(new Error('Treść odrzucona'), { status: 422 });
    };
    await krok(e);
    expect(patche(e).filter((x) => x.name)).toHaveLength(1);
    await krok(e);
    const poPierwszym = odczytaj(e, k);
    expect(poPierwszym.problemy).toMatchObject([{ kod: 'odczyt' }]);
    const termin = (o) => Date.parse(o.wyslanePola.odczytPo ?? o.nastepnaProbaAt);
    const przerwa1 = termin(poPierwszym) - e.teraz().getTime();
    expect(przerwa1).toBeGreaterThan(5000);
    await krok(e, 5000);
    expect(odczytaj(e, k).problemy).toMatchObject([{ kod: 'odczyt' }]);
    expect(patche(e).filter((x) => x.name)).toHaveLength(1);
    await krok(e, przerwa1 - 5000 + 1);
    expect(patche(e).filter((x) => x.name)).toHaveLength(2);
    await krok(e);
    const poDrugim = odczytaj(e, k);
    expect(poDrugim.problemy).toMatchObject([{ kod: 'odczyt' }]);
    expect(termin(poDrugim) - e.teraz().getTime()).toBeGreaterThan(przerwa1);
    expect(poDrugim.wyslanePola.probyOdczytu).toBe(2);
    expect(poDrugim.liczbaProb).toBe(0);
  });
  it('B2 dwa kolejne 4xx odczytu wydłużają przerwę, udane sprawdzenie zeruje licznik', async () => {
    const e = srodowisko();
    const k = await czynna(e);
    const stanOperacji = e.konto.allegro.stanOperacji;
    e.konto.allegro.stanOperacji = async () => {
      throw Object.assign(new Error('Odmowa odczytu'), { status: 403 });
    };
    const przerwy = [];
    for (let i = 0; i < 2; i++) {
      sprawdzana(e, k);
      await krok(e);
      const o = odczytaj(e, k);
      przerwy.push(Date.parse(o.wyslanePola.odczytPo ?? o.nastepnaProbaAt) - e.teraz().getTime());
    }
    expect(przerwy[1]).toBeGreaterThan(przerwy[0]);
    expect(odczytaj(e, k).wyslanePola.probyOdczytu).toBe(2);
    expect(odczytaj(e, k).liczbaProb).toBe(0);
    e.konto.allegro.stanOperacji = stanOperacji;
    sprawdzana(e, k);
    zmienOferte(e.db, k.ofertaId, { wyslanePola: { ...odczytaj(e, k).wyslanePola, operacja: null } });
    // Udany odczyt sam kasuje licznik treści — także gdy następny PATCH nie przejdzie (bez drugiej drogi E4.25).
    const katalog = e.konto.katalog;
    e.konto.katalog = { ...katalog, zmienOferte: async () => ({ ok: false, powod: 'Allegro chwilowo niedostępne' }) };
    await krok(e);
    e.konto.katalog = katalog;
    expect(odczytaj(e, k).liczbaProb).toBe(0);
    expect(odczytaj(e, k).wyslanePola.probyOdczytu).toBeUndefined();
    expect(odczytaj(e, k).wyslanePola.odczytPo).toBeUndefined();
  });
  it('B2 po 4 błędach odczytu licznik komend zostaje 0 (komenda ma dalej pełne MAKS_PROB_KOMENDY)', async () => {
    const e = srodowisko();
    const k = await czynna(e);
    e.konto.allegro.stanOperacji = async () => {
      throw Object.assign(new Error('Odmowa odczytu'), { status: 403 });
    };
    for (let i = 0; i < 4; i++) {
      sprawdzana(e, k);
      await krok(e);
    }
    expect(odczytaj(e, k).wyslanePola.probyOdczytu).toBe(4);
    expect(odczytaj(e, k).liczbaProb).toBe(0);
  });
  it('B2 stale odrzucana treść: po 5 próbach bez kolejnego PATCH, problem mówi o odrzuconej treści', async () => {
    const e = srodowisko();
    const k = await czynna(e);
    e.db
      .prepare('UPDATE karty_produktow SET nazwa = ? WHERE id = ?')
      .run('Lampa stołowa Gliwka z mlecznym kloszem', k.kartaId);
    const katalog = e.konto.katalog;
    e.konto.katalog = {
      ...katalog,
      zmienOferte: async (...args) => {
        const r = await katalog.zmienOferte(...args);
        return { ...r, dane: { ...r.dane, operacja: '/operacja-tresci', retryAfterS: 5 } };
      },
    };
    e.konto.allegro.stanOperacji = async () => {
      throw Object.assign(new Error('Treść odrzucona'), { status: 422 });
    };
    for (let i = 0; i < 12; i++) await krok(e, 24 * 3600 * 1000);
    expect(patche(e).filter((x) => x.name)).toHaveLength(5);
    const o = odczytaj(e, k);
    expect(o.wyslanePola.probyOdczytu).toBe(5);
    expect(o.problemy).toMatchObject([{ kod: 'odczyt' }]);
    expect(o.problemy[0].tekst).toContain('5 razy odrzuciło zmianę treści');
    expect(o.stan).toBe('problem');
    expect(ofertyDoDecyzji(e.db).map((r) => r.id)).toContain(k.ofertaId);
    zmienOferte(e.db, k.ofertaId, zmianyPonowienia(o, true));
    await krok(e);
    expect(patche(e).filter((x) => x.name)).toHaveLength(6);
    await krok(e);
    expect(odczytaj(e, k).wyslanePola.probyOdczytu).toBe(1);
    for (let i = 0; i < 12; i++) await krok(e, 24 * 3600 * 1000);
    expect(patche(e).filter((x) => x.name)).toHaveLength(10);
    expect(odczytaj(e, k).stan).toBe('problem');
    e.db
      .prepare('UPDATE karty_produktow SET nazwa = ? WHERE id = ?')
      .run('Lampa stołowa Gliwka z kloszem opal', k.kartaId);
    await krok(e);
    expect(patche(e).filter((x) => x.name)).toHaveLength(11);
    await krok(e);
    expect(odczytaj(e, k).wyslanePola.probyOdczytu).toBe(1);
    expect(odczytaj(e, k).problemy[0].tekst).toContain('Nie udało się odczytać');
  });
  for (const retryAfterS of [undefined, 300])
    it(`B2 problem odczytu nie omija przerw po 503 ENDED (Retry-After ${retryAfterS})`, async () => {
      const e = srodowisko();
      const k = await czynna(e);
      sprawdzana(e, k);
      e.konto.allegro.stanOperacji = async () => {
        throw Object.assign(new Error('Brak uprawnień'), { status: 403 });
      };
      await krok(e);
      wycofaj(e, k);
      const katalog = e.konto.katalog;
      e.konto.katalog = {
        ...katalog,
        zmienOferte: async (id, cialo) => {
          if (cialo.publication?.status === 'ENDED') {
            e.ciala.push({ zdarzenie: `PATCH /sale/product-offers/${id}`, cialo });
            throw Object.assign(new Error('Awaria Allegro'), { status: 503, retryAfterS });
          }
          return katalog.zmienOferte(id, cialo);
        },
      };
      await krok(e, 5000);
      expect(patche(e)).toHaveLength(1);
      const termin = Date.parse(odczytaj(e, k).nastepnaProbaAt);
      await krok(e, 1000);
      expect(patche(e)).toHaveLength(1);
      expect(odczytaj(e, k).nastepnaProbaAt).toBe(new Date(termin).toISOString());
      if (retryAfterS) expect(termin - e.teraz().getTime()).toBe(299_000);
      for (let i = 0; i < 12; i++) await krok(e, 5 * MIN);
      if (!retryAfterS) expect(patche(e).length).toBeLessThanOrEqual(5);
    });
  it('N4 zapis treści ze starszego przebiegu dociąga datę samoczynnego wznowienia z bazy', async () => {
    const e = srodowisko();
    const k = await czynna(e);
    const zakoncz = () =>
      e.zmienWAtrapie(odczytaj(e, k).idZewnetrzne, (o) => ({
        ...o,
        publication: { status: 'ENDED' },
        stock: { available: 0 },
      }));
    e.db.prepare('UPDATE karty_produktow SET nazwa = ? WHERE id = ?').run('Lampa Gliwka po zmianie opisu', k.kartaId);
    const katalog = e.konto.katalog;
    const stanOperacji = e.konto.allegro.stanOperacji;
    e.konto.allegro.stanOperacji = async (operacja) =>
      operacja === '/tresc-po-wznowieniu' ? { wToku: false } : stanOperacji(operacja);
    let wznowionaAt;
    e.konto.katalog = {
      ...katalog,
      zmienOferte: async (id, cialo) => {
        if (cialo.name && !wznowionaAt) {
          // Zapis treści ma już stare wyslanePola; drugi przebieg zdążył wznowić ofertę w trakcie await.
          zakoncz();
          await krok(e);
          wznowionaAt = odczytaj(e, k).wyslanePola.wznowionaAt;
          expect(wznowionaAt).toBe(e.teraz().toISOString());
        }
        const r = await katalog.zmienOferte(id, cialo);
        return cialo.name ? { ...r, dane: { ...r.dane, operacja: '/tresc-po-wznowieniu' } } : r;
      },
    };
    await krok(e);
    expect(odczytaj(e, k).wyslanePola.wznowionaAt).toBe(wznowionaAt);
    for (let i = 0; i < 3; i++) await krok(e);
    zakoncz();
    e.ciala.length = 0;
    await krok(e);
    expect(patche(e).filter((x) => x.publication?.status === 'ACTIVE')).toHaveLength(0);
    expect(odczytaj(e, k)).toMatchObject({ stan: 'problem', problemy: [{ kod: 'zakonczona', limitDobowy: true }] });
  });
  it('B1 wycofanie po zatwierdzeniu blokuje POST', async () => {
    const e = srodowisko();
    const k = karta(e.db, e.KONTO);
    wycofaj(e, k);
    await krok(e);
    expect(e.ile(/^POST \/sale\/product-offers$/)).toBe(0);
    expect(odczytaj(e, k)).toMatchObject({
      stan: 'blad',
      blad: 'Karta jest wycofana — oferta nie zostanie wystawiona.',
    });
  });
  it('B1 wycofanie po POST blokuje aktywację szkicu', async () => {
    const e = srodowisko({ ustawienia: { aktywujPoSprawdzeniu: false } });
    const k = karta(e.db, e.KONTO);
    await krok(e);
    wycofaj(e, k);
    zmienOferte(e.db, k.ofertaId, { stan: 'sprawdzana', nastepnaProbaAt: null });
    zapiszUstawieniaOfertKonta(e.db, e.KONTO, { aktywujPoSprawdzeniu: true });
    for (let i = 0; i < 5; i++) await krok(e);
    expect(patche(e).filter((x) => x.publication?.status === 'ACTIVE')).toHaveLength(0);
    expect(odczytaj(e, k)).toMatchObject({ stan: 'nieaktywna', wyslanePola: { szkic: true } });
  });
  for (const skutek of ['wycofanie', 'ilosc'])
    it(`B2 422 operacji treści nie blokuje: ${skutek}`, async () => {
      const e = srodowisko();
      const k = await czynna(e);
      sprawdzana(e, k);
      zmienOferte(e.db, k.ofertaId, { wyslanySkrot: 'poprzednia-tresc' });
      e.konto.allegro.stanOperacji = async () => {
        throw Object.assign(new Error('Odmowa'), { status: 422 });
      };
      await krok(e);
      expect(odczytaj(e, k)).toMatchObject({
        stan: 'aktywna',
        problemy: [{ kod: 'odczyt', tekst: expect.stringContaining('422') }],
      });
      if (skutek === 'wycofanie') wycofaj(e, k);
      else e.zmienWAtrapie(odczytaj(e, k).idZewnetrzne, (o) => ({ ...o, stock: { available: 1 } }));
      await krok(e, 5000);
      if (skutek === 'wycofanie') expect(patche(e)).toContainEqual({ publication: { status: 'ENDED' } });
      else expect(e.ciala.some((x) => x.zdarzenie.startsWith('PUT /sale/offer-quantity-change-commands/'))).toBe(true);
      expect(patche(e).filter((x) => x.name)).toHaveLength(0);
    });
  for (const [status, stan] of [
    ['ACTIVATING', 'aktywna'],
    ['INACTIVE', 'nieaktywna'],
    [null, 'problem'],
  ]) {
    it(`B2 403 odczytu oferty zachowuje synchronizację przy statusie ${status}`, async () => {
      const e = srodowisko();
      const k = await czynna(e);
      zmienOferte(e.db, k.ofertaId, {
        stan: 'sprawdzana',
        odczytStatus: status,
        nastepnaProbaAt: null,
        wyslanePola: { ...odczytaj(e, k).wyslanePola, etap: 'tresc', operacja: null },
      });
      e.konto.katalog = {
        ...e.konto.katalog,
        stanOferty: async () => {
          throw Object.assign(new Error('Brak uprawnień'), { status: 403 });
        },
        odczytOfert: async () => ({ ok: false, powod: 'Odczyt niedostępny' }),
      };
      await krok(e);
      expect(odczytaj(e, k)).toMatchObject({
        stan,
        problemy: [{ kod: 'odczyt', tekst: expect.stringContaining('403') }],
      });
    });
  }
  it('N1 zapis w trakcie await zachowuje wszystkie znaczniki człowieka', async () => {
    const e = srodowisko();
    const k = await czynna(e);
    sprawdzana(e, k);
    const znaczniki = { zdejmij: true, wznow: true, aktywuj: true, cenaPotwierdzonaGr: 5900 };
    let zachowane;
    const katalog = e.konto.katalog;
    e.konto.katalog = {
      ...katalog,
      stanOferty: async (...args) => {
        zachowane = odczytaj(e, k).wyslanePola;
        return katalog.stanOferty(...args);
      },
    };
    e.konto.allegro.stanOperacji = async () => {
      await Promise.resolve();
      zmienOferte(e.db, k.ofertaId, { wyslanePola: { ...odczytaj(e, k).wyslanePola, ...znaczniki } });
      return { wToku: false };
    };
    await krok(e);
    expect(zachowane).toMatchObject(znaczniki);
    expect(odczytaj(e, k).wyslanePola.zdejmij).toBe(true);
    await krok(e);
    expect(patche(e)).toContainEqual({ publication: { status: 'ENDED' } });
  });
  it('N3 zaległa komenda z 503 nie blokuje ENDED', async () => {
    const e = srodowisko();
    const k = await czynna(e);
    zmienOferte(e.db, k.ofertaId, {
      wyslanePola: { ...odczytaj(e, k).wyslanePola, komendaIlosci: { id: 'zalegla', wartosc: 5 } },
    });
    e.konto.allegro.wynikKomendy = async () => {
      throw Object.assign(new Error('Awaria'), { status: 503 });
    };
    wycofaj(e, k);
    await krok(e);
    expect(patche(e)).toContainEqual({ publication: { status: 'ENDED' } });
  });
  it('N4 najwyżej jedno automatyczne wznowienie na 24 h, ręczne bez limitu', async () => {
    const e = srodowisko();
    const k = await czynna(e);
    const zakoncz = () =>
      e.zmienWAtrapie(odczytaj(e, k).idZewnetrzne, (o) => ({
        ...o,
        publication: { status: 'ENDED' },
        stock: { available: 0 },
      }));
    zakoncz();
    await krok(e);
    expect(patche(e).filter((x) => x.publication?.status === 'ACTIVE')).toHaveLength(1);
    const at = odczytaj(e, k).wyslanePola.wznowionaAt;
    expect(at).toBe(e.teraz().toISOString());
    for (let i = 0; i < 5; i++) await krok(e);
    zakoncz();
    e.ciala.length = 0;
    await krok(e);
    expect(patche(e)).toHaveLength(0);
    expect(odczytaj(e, k)).toMatchObject({ stan: 'problem', problemy: [{ kod: 'zakonczona' }] });
    await krok(e, 24 * 3_600_000 + MIN);
    expect(patche(e).filter((x) => x.publication?.status === 'ACTIVE')).toHaveLength(1);
    for (let i = 0; i < 5; i++) await krok(e);
    zakoncz();
    zmienOferte(e.db, k.ofertaId, { wyslanePola: { ...odczytaj(e, k).wyslanePola, wznow: true } });
    e.ciala.length = 0;
    await krok(e);
    expect(patche(e).filter((x) => x.publication?.status === 'ACTIVE')).toHaveLength(1);
    expect(odczytaj(e, k).wyslanePola.wznow).toBeUndefined();
  });
});
