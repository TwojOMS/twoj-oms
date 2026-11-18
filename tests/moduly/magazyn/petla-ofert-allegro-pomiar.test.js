// Wznowienie wyprzedanej oferty bez offer-fee-preview i obsługa odpowiedzi zapisanych
// w fixture `e3-pomiar-*.json`.
// Atrapa ofert Allegro + prawdziwy rejestr kanałów i klient (pomocniki jak w petla-ofert-allegro.test.js).
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
import { zapiszUstawieniaOfertKonta, wstawOferte, ofertaPoId } from '../../../src/oms/db/oferty-kanalow.ts';
import { znakInstalacji } from '../../../src/moduly/magazyn/services/oferty-wspolne.js';
import { createAllegroClient } from '../../../src/oms/allegro/client.js';
import { katalogAllegro, wezlyAllegro } from '../../../src/integracje/kanal-modul.ts';
import { createSerwerOfertAllegro, API_ATRAPY_ALLEGRO } from '../../../deploy/proba/atrapy/allegro-oferty.mjs';
import { fixtureAllegro, daneAllegro, aktorAllegro } from '../../pomoc/allegro-konfigurator.ts';
import { createRejestrKanalow } from '../../../src/moduly/kanaly/services/rejestr-kanalow.ts';
import { createPetlaOfertAllegro } from '../../../src/moduly/magazyn/services/petla-ofert-allegro.js';
import { zapiszWyjatekCennika } from '../../../src/oms/db/cenniki-kart.ts';

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
const odp = (status, cialo) =>
  new Response(JSON.stringify(cialo), { status, headers: { 'Content-Type': 'application/json' } });

const PODGLAD = /^POST \/pricing\/offer-fee-preview$/;
const OPERACJA = /^GET \/sale\/product-offers\/[^/]+\/operations\//;
const ZAPISY = /^(PUT|PATCH) /;
const cialaPo = (e, wzor, od = 0) => e.ciala.slice(od).filter((c) => wzor.test(c.zdarzenie));
const przebieg = async (e, p, ms = MIN) => {
  e.przesun(ms);
  await p.przebieg();
};

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

// Wznowienie nie wywołuje `offer-fee-preview`; pilnuje tego `wznow-reczne-allegro.test.js`.
describe('E3.17 — D41: wznowienie wyprzedanej oferty (bez prognozy opłat od 14.11)', () => {
  it('wyprzedana → jeden PATCH ilości + ACTIVE bez offer-fee-preview → aktywna, potem cisza', async () => {
    const e = srodowisko();
    const { ofertaId, p, o } = await wystawiona(e);
    zakoncz(e, o.idZewnetrzne, 0);
    const przed = e.ciala.length;
    await przebieg(e, p);
    expect(cialaPo(e, PODGLAD, przed)).toEqual([]);
    expect(cialaPo(e, ZAPISY, przed).map((c) => c.cialo)).toEqual([
      { stock: { available: 5 }, publication: { status: 'ACTIVE' } },
    ]);
    expect(ofertaPoId(e.db, ofertaId).stan).toBe('sprawdzana');
    const po = await doKonca(e, p, ofertaId);
    expect(po.stan).toBe('aktywna');
    expect(po.problemy).toEqual([]);
    expect(po.wyslanePola.etap).toBeNull();
    const wAllegro = e.ofertaWAtrapie(o.idZewnetrzne);
    expect(wAllegro.publication.status).toBe('ACTIVE');
    expect(wAllegro.stock.available).toBe(5);
    const przed2 = e.ciala.length;
    await przebieg(e, p);
    expect(cialaPo(e, ZAPISY, przed2)).toEqual([]);
    expect(cialaPo(e, PODGLAD, przed2)).toEqual([]);
  });

  it('ENDED przy 3 sztukach (zakończona ręcznie) → problem zakonczona bez tekstu, bez fee-preview i zapisu', async () => {
    const e = srodowisko();
    const { ofertaId, p, o } = await wystawiona(e);
    zakoncz(e, o.idZewnetrzne, 3);
    const przed = e.ciala.length;
    await przebieg(e, p);
    await przebieg(e, p);
    expect(cialaPo(e, PODGLAD, przed)).toEqual([]);
    expect(cialaPo(e, ZAPISY, przed)).toEqual([]);
    const po = ofertaPoId(e.db, ofertaId);
    expect(po.stan).toBe('problem');
    expect(po.problemy).toEqual([{ kod: 'zakonczona', sztuk: 3 }]);
  });

  it('karta wycofana → bez wznowienia: nieaktywna, bez fee-preview i zapisu', async () => {
    const e = srodowisko();
    const { ofertaId, kartaId, p, o } = await wystawiona(e);
    zakoncz(e, o.idZewnetrzne, 0);
    e.db.prepare('UPDATE karty_produktow SET wycofana = 1 WHERE id = ?').run(kartaId);
    const przed = e.ciala.length;
    await przebieg(e, p);
    await przebieg(e, p);
    expect(cialaPo(e, PODGLAD, przed)).toEqual([]);
    expect(cialaPo(e, ZAPISY, przed)).toEqual([]);
    expect(ofertaPoId(e.db, ofertaId).stan).toBe('nieaktywna');
  });

  it('stała ilość konta pusta → błąd karty obok „zakończona”, bez wznowienia i bez fee-preview', async () => {
    const e = srodowisko();
    const { ofertaId, p, o } = await wystawiona(e);
    zapiszUstawieniaOfertKonta(e.db, e.KONTO, { stalaIlosc: null }, { teraz: e.teraz().toISOString() });
    zakoncz(e, o.idZewnetrzne, 0);
    const przed = e.ciala.length;
    await przebieg(e, p);
    expect(cialaPo(e, PODGLAD, przed)).toEqual([]);
    expect(cialaPo(e, ZAPISY, przed)).toEqual([]);
    expect(ofertaPoId(e.db, ofertaId).problemy).toEqual([
      { kod: 'zakonczona', sztuk: 0 },
      { kod: 'karta', tekst: expect.stringContaining('stała liczba sztuk') },
    ]);
  });

  it('konto tylko do odczytu → ani prognozy, ani zapisu', async () => {
    let zamknieta = false;
    const e = srodowisko({ tylkoOdczyt: () => zamknieta });
    const { p, o } = await wystawiona(e);
    zakoncz(e, o.idZewnetrzne, 0);
    zamknieta = true;
    const przed = e.ciala.length;
    await przebieg(e, p);
    expect(cialaPo(e, PODGLAD, przed)).toEqual([]);
    expect(cialaPo(e, ZAPISY, przed)).toEqual([]);
  });

  it('bramka zamknięta w trakcie odczytu listy (przed prognozą) → ani prognozy, ani zapisu, problem bez tekstu', async () => {
    let zamknieta = false;
    const e = srodowisko({ tylkoOdczyt: () => zamknieta });
    const { ofertaId, p, o } = await wystawiona(e);
    zakoncz(e, o.idZewnetrzne, 0);
    e.st.awaria = (m, s) => {
      if (m === 'GET' && s === '/sale/offers') zamknieta = true;
      return null;
    };
    const przed = e.ciala.length;
    await przebieg(e, p);
    expect(cialaPo(e, PODGLAD, przed)).toEqual([]);
    expect(cialaPo(e, ZAPISY, przed)).toEqual([]);
    expect(ofertaPoId(e.db, ofertaId).problemy).toEqual([{ kod: 'zakonczona', sztuk: 0 }]);
  });

  it('PATCH wznowienia 500 → problem bez tekstu z przerwą; przed jej końcem bez prognozy, po niej wznowienie', async () => {
    const e = srodowisko();
    const { ofertaId, p, o } = await wystawiona(e);
    zakoncz(e, o.idZewnetrzne, 0);
    e.st.awaria = (m, s) =>
      m === 'PATCH' && s.startsWith('/sale/product-offers/') ? odp(500, { errors: [{ code: 'InternalError' }] }) : null;
    const przed = e.ciala.length;
    await przebieg(e, p);
    const po = ofertaPoId(e.db, ofertaId);
    expect(po.stan).toBe('problem');
    expect(po.problemy).toEqual([{ kod: 'zakonczona', sztuk: 0 }]);
    expect(po.liczbaProb).toBe(1);
    expect(Date.parse(po.nastepnaProbaAt)).toBeGreaterThan(Date.parse(po.odczytanoAt));
    e.st.awaria = null;
    const przed2 = e.ciala.length;
    await przebieg(e, p, 1000);
    expect(cialaPo(e, PODGLAD, przed2)).toEqual([]);
    expect(cialaPo(e, ZAPISY, przed2)).toEqual([]);
    await przebieg(e, p);
    expect(cialaPo(e, ZAPISY, przed).filter((c) => c.cialo?.publication?.status === 'ACTIVE')).toHaveLength(2);
    expect(ofertaPoId(e.db, ofertaId).stan).toBe('sprawdzana');
  });

  it('PATCH wznowienia 500 za każdym razem → po 5 próbach problem z tekstem i cisza', async () => {
    const e = srodowisko();
    const { ofertaId, p, o } = await wystawiona(e);
    zakoncz(e, o.idZewnetrzne, 0);
    e.st.awaria = (m, s) =>
      m === 'PATCH' && s.startsWith('/sale/product-offers/') ? odp(500, { errors: [{ code: 'InternalError' }] }) : null;
    const przed = e.ciala.length;
    const wznowienia = () => cialaPo(e, ZAPISY, przed).filter((c) => c.cialo?.publication?.status === 'ACTIVE').length;
    for (let i = 1; i <= 4; i++) {
      await przebieg(e, p, 10 * MIN);
      expect(wznowienia()).toBe(i);
      expect(ofertaPoId(e.db, ofertaId).problemy).toEqual([{ kod: 'zakonczona', sztuk: 0 }]);
    }
    await przebieg(e, p, 10 * MIN);
    expect(wznowienia()).toBe(5);
    const po = ofertaPoId(e.db, ofertaId);
    expect(po.stan).toBe('problem');
    expect(po.liczbaProb).toBe(5);
    expect(po.nastepnaProbaAt).toBeNull();
    expect(po.problemy).toEqual([
      { kod: 'zakonczona', sztuk: 0, tekst: expect.stringMatching(/5 razy.*wznów ręcznie/) },
    ]);
    const przed2 = e.ciala.length;
    await przebieg(e, p, 2 * 60 * MIN);
    await przebieg(e, p, 2 * 60 * MIN);
    expect(cialaPo(e, PODGLAD, przed2)).toEqual([]);
    expect(cialaPo(e, ZAPISY, przed2)).toEqual([]);
  });

  for (const [opis, stock] of [
    [
      'bez stock.available',
      (s) => {
        const { available: _a, ...r } = s;
        return r;
      },
    ],
    ['stock.available = null', (s) => ({ ...s, available: null })],
    ['bez stock', () => undefined],
  ]) {
    it(`ENDED ${opis} (ilość nieznana) → problem bez tekstu, bez fee-preview i PATCH`, async () => {
      const e = srodowisko();
      const { ofertaId, p, o } = await wystawiona(e);
      e.zmienWAtrapie(o.idZewnetrzne, (x) => ({
        ...x,
        stock: stock(x.stock ?? {}),
        publication: { ...x.publication, status: 'ENDED' },
      }));
      const przed = e.ciala.length;
      await przebieg(e, p);
      expect(cialaPo(e, PODGLAD, przed)).toEqual([]);
      expect(cialaPo(e, ZAPISY, przed)).toEqual([]);
      const po = ofertaPoId(e.db, ofertaId);
      expect(po.stan).toBe('problem');
      expect(po.odczytIlosc).toBeNull();
      expect(po.problemy).toEqual([{ kod: 'zakonczona', sztuk: 0 }]);
    });
  }

  it('PATCH wznowienia odrzucony 422 (P17 „active”) → problem z tekstem Allegro, jedna próba', async () => {
    const e = srodowisko();
    const { ofertaId, p, o } = await wystawiona(e);
    zakoncz(e, o.idZewnetrzne, 0);
    e.st.awaria = (m, s) =>
      m === 'PATCH' && s.startsWith('/sale/product-offers/') ? odp(P17.active.status, P17.active.body) : null;
    const przed = e.ciala.length;
    await przebieg(e, p);
    await przebieg(e, p);
    await przebieg(e, p);
    expect(cialaPo(e, ZAPISY, przed)).toHaveLength(1);
    const po = ofertaPoId(e.db, ofertaId);
    expect(po.stan).toBe('problem');
    expect(po.problemy).toEqual([
      { kod: 'zakonczona', sztuk: 0, tekst: expect.stringContaining('Oferta nie zawiera wymaganych danych: stock.') },
    ]);
  });

  it('operacja wznowienia kończy się 4xx → problem z tekstem, bez ponowienia', async () => {
    const e = srodowisko();
    const { ofertaId, p, o } = await wystawiona(e);
    zakoncz(e, o.idZewnetrzne, 0);
    const przed = e.ciala.length;
    await przebieg(e, p);
    expect(ofertaPoId(e.db, ofertaId).stan).toBe('sprawdzana');
    e.st.awaria = (m, s) =>
      OPERACJA.test(`${m} ${s}`) ? odp(P17.ended_operacja.status, P17.ended_operacja.body) : null;
    const po = await doKonca(e, p, ofertaId);
    expect(po.stan).toBe('problem');
    expect(po.problemy).toEqual([
      { kod: 'zakonczona', sztuk: 0, tekst: expect.stringMatching(/odrzuciło wznowienie.*HTTP 422.*inactive offer/) },
    ]);
    await przebieg(e, p);
    expect(cialaPo(e, ZAPISY, przed)).toHaveLength(1);
  });

  it('Allegro przyjęło PATCH, ale oferta dalej ENDED → problem „nie wznowiło”, bez drugiej próby', async () => {
    const e = srodowisko();
    const { ofertaId, p, o } = await wystawiona(e);
    zakoncz(e, o.idZewnetrzne, 0);
    const przed = e.ciala.length;
    await przebieg(e, p);
    // Operacja przechodzi (303), lecz oferta zostaje zakończona — pole status czytane z odczytu oferty.
    e.st.awaria = (m, s) =>
      OPERACJA.test(`${m} ${s}`)
        ? new Response(null, { status: 303, headers: { Location: `/sale/product-offers/${o.idZewnetrzne}` } })
        : null;
    const po = await doKonca(e, p, ofertaId);
    expect(po.stan).toBe('problem');
    expect(po.problemy).toEqual([{ kod: 'zakonczona', sztuk: 0, tekst: expect.stringContaining('ENDED') }]);
    await przebieg(e, p);
    expect(cialaPo(e, ZAPISY, przed)).toHaveLength(1);
  });

  it('po problemie ręczne wznowienie w Allegro → aktywna, problem zdjęty', async () => {
    const e = srodowisko();
    const { ofertaId, p, o } = await wystawiona(e);
    zakoncz(e, o.idZewnetrzne, 0);
    e.st.awaria = (m, s) =>
      m === 'PATCH' && s.startsWith('/sale/product-offers/') ? odp(P17.active.status, P17.active.body) : null;
    await przebieg(e, p);
    expect(ofertaPoId(e.db, ofertaId).stan).toBe('problem');
    e.st.awaria = null;
    e.zmienWAtrapie(o.idZewnetrzne, (x) => ({
      ...x,
      stock: { ...x.stock, available: 5 },
      publication: { ...x.publication, status: 'ACTIVE' },
    }));
    await przebieg(e, p);
    const po = ofertaPoId(e.db, ofertaId);
    expect(po.stan).toBe('aktywna');
    expect(po.problemy).toEqual([]);
  });
});

describe('E3.17 — rozbieżności z pomiaru', () => {
  it('P17: operacja zdjęcia kończy się 422 IllegalChangeInactiveOffer → odczyt oferty, nieaktywna (nie błąd)', async () => {
    const e = srodowisko();
    const { ofertaId, kartaId, p, o } = await wystawiona(e);
    e.db.prepare('UPDATE karty_produktow SET wycofana = 1 WHERE id = ?').run(kartaId);
    await przebieg(e, p, 1000);
    expect(ofertaPoId(e.db, ofertaId).wyslanePola.etap).toBe('zdejmowanie');
    // Oferta stała się nieaktywna, zanim operacja się skończyła — Allegro kończy operację 422 (P17).
    e.zmienWAtrapie(o.idZewnetrzne, (x) => ({ ...x, publication: { ...x.publication, status: 'INACTIVE' } }));
    e.st.awaria = (m, s) =>
      OPERACJA.test(`${m} ${s}`) ? odp(P17.ended_operacja.status, P17.ended_operacja.body) : null;
    const po = await doKonca(e, p, ofertaId);
    expect(po.stan).toBe('nieaktywna');
    expect(po.blad).toBeNull();
    expect(po.wyslanePola.wycofanoAt).toEqual(expect.any(String));
  });

  it('P17: operacja zdjęcia 422, a oferta dalej aktywna → aktywna z ponowieniem później (nie błąd)', async () => {
    const e = srodowisko();
    const { ofertaId, kartaId, p } = await wystawiona(e);
    e.db.prepare('UPDATE karty_produktow SET wycofana = 1 WHERE id = ?').run(kartaId);
    await przebieg(e, p, 1000);
    e.st.awaria = (m, s) =>
      OPERACJA.test(`${m} ${s}`) ? odp(P17.ended_operacja.status, P17.ended_operacja.body) : null;
    const po = await doKonca(e, p, ofertaId);
    expect(po.stan).toBe('aktywna');
    expect(po.wyslanePola.wycofanoAt).toBeUndefined();
  });

  it('P12: POST bez parametrów requiredForProduct → 422 bez szkicu → błąd z nazwami parametrów, bez ponowienia', async () => {
    const e = srodowisko();
    const { ofertaId } = karta(e.db, e.KONTO);
    e.st.awaria = (m, s) => (m === 'POST' && s === '/sale/product-offers' ? odp(P12.status, P12.body) : null);
    const p = e.petla();
    await p.przebieg();
    const o = ofertaPoId(e.db, ofertaId);
    expect(o.stan).toBe('blad');
    expect(o.blad).toContain('EAN (GTIN)');
    expect(o.idZewnetrzne.startsWith('ext:')).toBe(true);
    await przebieg(e, p);
    expect(e.ile(POST)).toBe(1);
  });
});

// Wyjątek cennika z karty, który zniknął z listy konta po „Pobierz z Allegro”, odmawia
// tylko przy tworzeniu oferty (podgląd/zatwierdzenie) — cena i ilość żywej oferty oraz wznowienie idą dalej.
describe('E3d.02-03p3 — wyjątek cennika spoza listy a żywa oferta', () => {
  const zListy = { slowniki: { cenniki: [{ id: 'cen-a', nazwa: 'Kurier A' }] } };
  async function zWyjatkiemSpozaListy(e) {
    const k = karta(e.db, e.KONTO);
    zapiszWyjatekCennika(
      e.db,
      { kartaId: k.kartaId, konto: e.KONTO, cennik: 'cen-a' },
      { teraz: e.teraz().toISOString() },
    );
    const p = e.petla();
    const o = await doKonca(e, p, k.ofertaId);
    expect(o.stan).toBe('aktywna');
    zapiszUstawieniaOfertKonta(
      e.db,
      e.KONTO,
      { slowniki: { cenniki: [{ id: 'cen-b', nazwa: 'Kurier B' }] } },
      { teraz: e.teraz().toISOString() },
    );
    return { ...k, p, o };
  }

  it('zmiana stałej ilości konta 5→7 idzie do Allegro, bez problemu „karta”', async () => {
    const e = srodowisko({ ustawienia: zListy });
    const { ofertaId, p, o } = await zWyjatkiemSpozaListy(e);
    zapiszUstawieniaOfertKonta(e.db, e.KONTO, { stalaIlosc: 7 }, { teraz: e.teraz().toISOString() });
    for (let i = 0; i < 4; i++) await przebieg(e, p, MIN * 6);
    expect(e.ofertaWAtrapie(o.idZewnetrzne).stock.available).toBe(7);
    expect(ofertaPoId(e.db, ofertaId).problemy.filter((x) => x.kod === 'karta')).toEqual([]);
  });

  it('wyprzedana oferta wznawia się (PATCH ilości + ACTIVE)', async () => {
    const e = srodowisko({ ustawienia: zListy });
    const { p, o } = await zWyjatkiemSpozaListy(e);
    zakoncz(e, o.idZewnetrzne, 0);
    const przed = e.ciala.length;
    await przebieg(e, p);
    expect(cialaPo(e, ZAPISY, przed).map((c) => c.cialo)).toEqual([
      { stock: { available: 5 }, publication: { status: 'ACTIVE' } },
    ]);
  });
  // Wyjątek zniknął z konta między zatwierdzeniem a wysyłką — POST nie idzie, oferta ma czytelny błąd.
  it('nowa oferta z wyjątkiem spoza listy konta → błąd z tekstem, bez POST', async () => {
    const e = srodowisko({ ustawienia: { slowniki: { cenniki: [{ id: 'cen-b', nazwa: 'Kurier B' }] } } });
    const k = karta(e.db, e.KONTO);
    zapiszWyjatekCennika(
      e.db,
      { kartaId: k.kartaId, konto: e.KONTO, cennik: 'cen-a' },
      { teraz: e.teraz().toISOString() },
    );
    const p = e.petla();
    await p.przebieg();
    const o = ofertaPoId(e.db, k.ofertaId);
    expect(o.stan).toBe('blad');
    expect(o.blad).toContain('Cennik z karty nie istnieje już na koncie Allegro');
    expect(e.ile(POST)).toBe(0);
  });
});
