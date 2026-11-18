// Ręczne „Wznów” (znacznik wyslanePola.wznow) i wznowienie wyprzedanej bez prognozy opłat
// (bez sprawdzania opłat) oraz świeża oferta jeszcze nieobecna na liście /sale/offers.
// Atrapa ofert Allegro + prawdziwy rejestr kanałów i klient (środowisko jak w petla-ofert-allegro-pomiar.test.js).
// Żadnej sieci. Dane zmyślone: lampy „Pracownia Półcień”.
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

/** Karta z kategorią z mapy, regułami, marką, GPSR konta, `n` zdjęciami i EAN demo. */
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

/** Przebiegi co `krok` aż do stanu końcowego (najwyżej `n`). */
async function doKonca(e, p, ofertaId, { krok = 6000, n = 8 } = {}) {
  for (let i = 0; i < n && ['do_wyslania', 'wyslana', 'sprawdzana'].includes(ofertaPoId(e.db, ofertaId).stan); i++) {
    e.przesun(krok);
    await p.przebieg();
  }
  return ofertaPoId(e.db, ofertaId);
}

const odp = (status, cialo) =>
  new Response(JSON.stringify(cialo), { status, headers: { 'Content-Type': 'application/json' } });
const PODGLAD = /^POST \/pricing\/offer-fee-preview$/;
const ZAPISY = /^(PUT|PATCH) /;
const cialaPo = (e, wzor, od = 0) => e.ciala.slice(od).filter((c) => wzor.test(c.zdarzenie));
const wznowienia = (e, od) => cialaPo(e, ZAPISY, od).filter((c) => c.cialo?.publication?.status === 'ACTIVE');
const przebieg = async (e, p, ms = MIN) => {
  e.przesun(ms);
  await p.przebieg();
};
const PATCH_500 = (m, s) =>
  m === 'PATCH' && s.startsWith('/sale/product-offers/') ? odp(500, { errors: [{ code: 'InternalError' }] }) : null;

async function wystawiona(e, opcje) {
  const k = karta(e.db, e.KONTO, opcje);
  const p = e.petla();
  const o = await doKonca(e, p, k.ofertaId);
  expect(o.stan).toBe('aktywna');
  return { ...k, p, o };
}
/** Oferta zakończona w Allegro przy `sztuk` sztukach (wyprzedana albo ręcznie). */
const zakoncz = (e, id, sztuk) =>
  e.zmienWAtrapie(id, (x) => ({
    ...x,
    stock: { ...x.stock, available: sztuk },
    publication: { ...x.publication, status: 'ENDED' },
  }));
/** To, co robi przycisk „Wznów”: znacznik `wznow` w wyslanePola, licznik prób od zera. */
function wcisnijWznow(e, ofertaId) {
  const o = ofertaPoId(e.db, ofertaId);
  zmienOferte(
    e.db,
    ofertaId,
    {
      wyslanePola: { ...(o.wyslanePola ?? {}), wznow: { login: 'ala', at: e.teraz().toISOString() } },
      liczbaProb: 0,
      nastepnaProbaAt: null,
    },
    { teraz: e.teraz().toISOString() },
  );
}
/** Oferta zakończona ręcznie w Allegro (3 sztuki zostały) → problem „zakończona”, czeka na człowieka. */
async function zakonczonaRecznie(e, opcje) {
  const w = await wystawiona(e, opcje);
  zakoncz(e, w.o.idZewnetrzne, 3);
  await przebieg(e, w.p);
  expect(ofertaPoId(e.db, w.ofertaId).problemy).toEqual([{ kod: 'zakonczona', sztuk: 3 }]);
  return w;
}

describe('E3.28-02 — ręczne Wznów (znacznik wyslanePola.wznow)', () => {
  it('zakończona ręcznie + Wznów → jeden PATCH ilości i ACTIVE bez prognozy opłat, znacznik zdjęty, potem aktywna', async () => {
    const e = srodowisko();
    const { ofertaId, p, o } = await zakonczonaRecznie(e);
    const przed = e.ciala.length;
    await przebieg(e, p);
    expect(wznowienia(e, przed)).toHaveLength(0);
    wcisnijWznow(e, ofertaId);
    await przebieg(e, p);
    expect(cialaPo(e, ZAPISY, przed).map((c) => c.cialo)).toEqual([
      { stock: { available: 5 }, publication: { status: 'ACTIVE' } },
    ]);
    expect(cialaPo(e, PODGLAD, przed)).toEqual([]);
    const w = ofertaPoId(e.db, ofertaId);
    expect(w.stan).toBe('sprawdzana');
    expect(w.wyslanePola.etap).toBe('wznowienie');
    expect(w.wyslanePola.wznow).toBeUndefined();
    const po = await doKonca(e, p, ofertaId);
    expect(po.stan).toBe('aktywna');
    expect(po.problemy).toEqual([]);
    expect(e.ofertaWAtrapie(o.idZewnetrzne).publication.status).toBe('ACTIVE');
    const przed2 = e.ciala.length;
    await przebieg(e, p);
    expect(cialaPo(e, ZAPISY, przed2)).toEqual([]);
  });

  it('pętla już odmówiła (problem z powodem po 422) + Wznów → jeden PATCH', async () => {
    const e = srodowisko();
    const { ofertaId, p, o } = await wystawiona(e);
    zakoncz(e, o.idZewnetrzne, 0);
    e.st.awaria = (m, s) =>
      m === 'PATCH' && s.startsWith('/sale/product-offers/')
        ? odp(422, { errors: [{ code: 'X', userMessage: 'Brak danych' }] })
        : null;
    await przebieg(e, p);
    expect(ofertaPoId(e.db, ofertaId).problemy).toEqual([
      { kod: 'zakonczona', sztuk: 0, tekst: expect.stringContaining('Brak danych') },
    ]);
    e.st.awaria = null;
    const przed = e.ciala.length;
    await przebieg(e, p);
    expect(wznowienia(e, przed)).toHaveLength(0);
    wcisnijWznow(e, ofertaId);
    await przebieg(e, p);
    expect(wznowienia(e, przed)).toHaveLength(1);
    expect(ofertaPoId(e.db, ofertaId).stan).toBe('sprawdzana');
  });

  it('Wznów, a konto bez stałej liczby sztuk (błąd karty) → bez PATCH, powód w problemie trwa, znacznik zdjęty', async () => {
    const e = srodowisko();
    const { ofertaId, p } = await zakonczonaRecznie(e);
    zapiszUstawieniaOfertKonta(e.db, e.KONTO, { stalaIlosc: null }, { teraz: e.teraz().toISOString() });
    wcisnijWznow(e, ofertaId);
    const przed = e.ciala.length;
    await przebieg(e, p);
    await przebieg(e, p);
    expect(cialaPo(e, ZAPISY, przed)).toEqual([]);
    const po = ofertaPoId(e.db, ofertaId);
    expect(po.stan).toBe('problem');
    expect(po.problemy).toEqual([
      { kod: 'zakonczona', sztuk: 3, tekst: expect.stringContaining('Wznów') },
      { kod: 'karta', tekst: expect.stringContaining('stała liczba sztuk') },
    ]);
    expect(po.wyslanePola.wznow).toBeUndefined();
  });

  it('Wznów na wycofanej karcie → bez PATCH, nieaktywna, znacznik zdjęty', async () => {
    const e = srodowisko();
    const { ofertaId, kartaId, p } = await zakonczonaRecznie(e);
    e.db.prepare('UPDATE karty_produktow SET wycofana = 1 WHERE id = ?').run(kartaId);
    wcisnijWznow(e, ofertaId);
    const przed = e.ciala.length;
    await przebieg(e, p);
    await przebieg(e, p);
    expect(cialaPo(e, ZAPISY, przed)).toEqual([]);
    const po = ofertaPoId(e.db, ofertaId);
    expect(po.stan).toBe('nieaktywna');
    expect(po.wyslanePola.wznow).toBeUndefined();
  });

  it('Wznów przy koncie tylko do odczytu → bez PATCH, znacznik czeka; po otwarciu konta jeden PATCH', async () => {
    let zamknieta = false;
    const e = srodowisko({ tylkoOdczyt: () => zamknieta });
    const { ofertaId, p } = await zakonczonaRecznie(e);
    zamknieta = true;
    wcisnijWznow(e, ofertaId);
    const przed = e.ciala.length;
    await przebieg(e, p);
    await przebieg(e, p);
    expect(cialaPo(e, ZAPISY, przed)).toEqual([]);
    expect(ofertaPoId(e.db, ofertaId).wyslanePola.wznow).toEqual(expect.objectContaining({ login: 'ala' }));
    zamknieta = false;
    await przebieg(e, p);
    expect(wznowienia(e, przed)).toHaveLength(1);
  });

  it('Wznów, a PATCH 500 za każdym razem → 5 prób, potem problem z powodem, znacznik zdjęty i cisza', async () => {
    const e = srodowisko();
    const { ofertaId, p } = await zakonczonaRecznie(e);
    e.st.awaria = PATCH_500;
    wcisnijWznow(e, ofertaId);
    const przed = e.ciala.length;
    for (let i = 1; i <= 4; i++) {
      await przebieg(e, p, 10 * MIN);
      expect(wznowienia(e, przed)).toHaveLength(i);
      const w = ofertaPoId(e.db, ofertaId);
      expect(w.problemy).toEqual([{ kod: 'zakonczona', sztuk: 3 }]);
      expect(w.wyslanePola.wznow).toBeDefined();
    }
    await przebieg(e, p, 10 * MIN);
    expect(wznowienia(e, przed)).toHaveLength(5);
    const po = ofertaPoId(e.db, ofertaId);
    expect(po.liczbaProb).toBe(5);
    expect(po.nastepnaProbaAt).toBeNull();
    expect(po.problemy).toEqual([{ kod: 'zakonczona', sztuk: 3, tekst: expect.stringMatching(/5 razy/) }]);
    expect(po.wyslanePola.wznow).toBeUndefined();
    await przebieg(e, p, 2 * 60 * MIN);
    await przebieg(e, p, 2 * 60 * MIN);
    expect(wznowienia(e, przed)).toHaveLength(5);
  });

  it('Wznów przy ofercie aktywnej → znacznik zdjęty, bez PATCH', async () => {
    const e = srodowisko();
    const { ofertaId, p } = await wystawiona(e);
    wcisnijWznow(e, ofertaId);
    const przed = e.ciala.length;
    await przebieg(e, p);
    expect(cialaPo(e, ZAPISY, przed)).toEqual([]);
    const po = ofertaPoId(e.db, ofertaId);
    expect(po.stan).toBe('aktywna');
    expect(po.wyslanePola.wznow).toBeUndefined();
  });
});

describe('E3.28-02 — D41 bez prognozy opłat (decyzja właściciela 14.11)', () => {
  it('wyprzedana → wznowienie bez offer-fee-preview, nawet gdy prognoza pokazałaby opłatę', async () => {
    const e = srodowisko();
    const { ofertaId, p, o } = await wystawiona(e);
    zakoncz(e, o.idZewnetrzne, 0);
    e.st.awaria = (m, s) =>
      m === 'POST' && s === '/pricing/offer-fee-preview'
        ? odp(200, { quotes: [{ fee: { amount: '1.00', currency: 'PLN' } }] })
        : null;
    const przed = e.ciala.length;
    await przebieg(e, p);
    expect(cialaPo(e, PODGLAD, przed)).toEqual([]);
    expect(wznowienia(e, przed)).toHaveLength(1);
    expect(ofertaPoId(e.db, ofertaId).stan).toBe('sprawdzana');
  });
});

describe('E3.28-02 — świeżo wystawiona oferta jeszcze nie na liście /sale/offers (piaskownica r4)', () => {
  const pustaLista = (m, s) =>
    m === 'GET' && s === '/sale/offers' ? odp(200, { offers: [], count: 0, totalCount: 0 }) : null;

  it('po POST lista bez nowej oferty → bez brak-w-allegro; po 15 min dalej brak → brak-w-allegro', async () => {
    const e = srodowisko();
    e.st.awaria = pustaLista;
    const { ofertaId, p } = await wystawiona(e);
    await przebieg(e, p, 5 * MIN);
    const w = ofertaPoId(e.db, ofertaId);
    expect(w.stan).toBe('aktywna');
    expect(w.problemy).toEqual([]);
    await przebieg(e, p, 15 * MIN);
    const po = ofertaPoId(e.db, ofertaId);
    expect(po.stan).toBe('problem');
    expect(po.problemy).toEqual([{ kod: 'brak-w-allegro' }]);
  });

  it('oferta już odczytana z listy, potem jej brak → brak-w-allegro od razu', async () => {
    const e = srodowisko();
    const { ofertaId, p } = await wystawiona(e);
    await przebieg(e, p);
    expect(ofertaPoId(e.db, ofertaId).odczytanoAt).not.toBeNull();
    e.st.awaria = pustaLista;
    await przebieg(e, p);
    expect(ofertaPoId(e.db, ofertaId).problemy).toEqual([{ kod: 'brak-w-allegro' }]);
  });

  it('po odmowie z problemem karty (wiele-produktow) i ponownym Wznów → pętla czyta ofertę, znacznik nie zostaje na zawsze', async () => {
    // Wiersz z problemem spoza PROBLEMY_SYNCHRONIZACJI wypadał z kandydatów mimo znacznika „Wznów”.
    const e = srodowisko();
    const { ofertaId, p } = await zakonczonaRecznie(e);
    zmienOferte(
      e.db,
      ofertaId,
      {
        stan: 'problem',
        nastepnaProbaAt: null,
        problemy: [
          { kod: 'zakonczona', sztuk: 3, tekst: 'Nie wznowiono: popraw kartę, potem wciśnij Wznów.' },
          {
            kod: 'wiele-produktow',
            produkty: [
              { id: '1', nazwa: 'a', ean: null },
              { id: '2', nazwa: 'b', ean: null },
            ],
          },
        ],
      },
      { teraz: e.teraz().toISOString() },
    );
    wcisnijWznow(e, ofertaId);
    for (let i = 0; i < 4; i++) await przebieg(e, p, 30 * MIN);
    expect(ofertaPoId(e.db, ofertaId).wyslanePola.wznow).toBeUndefined();
  });
});
