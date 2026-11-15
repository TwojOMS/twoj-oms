import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { zapiszProduktSklepowy, powiazProdukt, utworzKarte } from '../../../src/oms/db/magazyn.js';
import { przelaczStany } from '../../../src/oms/db/stany-magazynowe.js';
import { createMagazynPrzebieg } from '../../../src/moduly/magazyn/services/magazyn-przebieg.js';
import { kolejka, createTrescAllegroPrzebieg } from '../../../src/moduly/magazyn/services/allegro-tresc-kart.js';
import { typImportu, planImportu, wykonajImport } from '../../../src/moduly/magazyn/services/import-kanalu.js';

// PRZ-160 P3b.03 (punkt 19) — ekran importu `/magazyn/import`: jeden kanał, pięć typów, „Sprawdź” (podgląd liczb,
// nic nie zapisuje do kart) i „Importuj” (wykonanie, ekran wyniku). Dane zmyślone („Pracownia Półcień”).

const config = { auth: { user: 'adam', pass: 'x' } };
const auth = {
  authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`,
  origin: 'http://localhost',
  'content-type': 'application/x-www-form-urlencoded',
};
const ZDANIE_D3 = 'Allegro zabrania używania treści pobranych z ofert w innych serwisach sprzedażowych — decyzja należy do Ciebie';
const TYPY = {
  powiaz: 'Produkty są już w magazynie — tylko powiąż je z tym kanałem',
  czesc: 'Część produktów jest w magazynie — powiąż istniejące i utwórz brakujące',
  pelny: 'Pobierz nowe i zaktualizuj istniejące',
  aktualizuj: 'Tylko zaktualizuj wcześniej zaimportowane',
  nowe: 'Tylko pobierz nowe (bez aktualizacji)',
};

const produktWoo = (id, sku, nazwa, ean) => ({
  id, name: nazwa, sku, type: 'simple', global_unique_id: ean, description: `<p>Opis: ${nazwa}</p>`,
  images: [], categories: [], attributes: [],
});
// Sklep „pro": p1 ma kartę o tym SKU (do powiązania), p2 nie ma (do utworzenia), p3 i p4 już powiązane.
const KATALOG_PRO = [
  produktWoo(101, 'PP-LAMPA-01', 'Lampa Półcień 01', '5901234123457'),
  produktWoo(102, 'PP-NOWY-02', 'Kinkiet Półcień 02', '5901234123440'),
  produktWoo(103, 'PP-STARY-03', 'Abażur Półcień 03', '5901234123464'),
  produktWoo(104, 'PP-RECZNY-04', 'Plafon Półcień 04', '5901234123471'),
];
const OFERTY = [
  { id: '7001', name: 'Lampa Półcień na Allegro', external: { id: 'PP-LAMPA-01' }, sellingMode: { price: { amount: '120.00', currency: 'PLN' } } },
  { id: '7002', name: 'Kubek bez SKU', sellingMode: { price: { amount: '30.00', currency: 'PLN' } } },
];

let db;
let karty;
let sklepy;
let allegro;
let tresc;

const kartaSql = (id) => db.prepare('SELECT * FROM karty_produktow WHERE id = ?').get(id);
const liczbaKart = () => db.prepare('SELECT COUNT(*) AS n FROM karty_produktow').get().n;
const wiersz = (kanal, produktId) => db.prepare('SELECT * FROM produkty_sklepowe WHERE kanal = ? AND produkt_id = ?').get(kanal, produktId);
const lustro = (kanal, produktId, nazwa, sku) => zapiszProduktSklepowy(db, {
  kanal, produkt_id: produktId, wariant_id: '', nazwa, sku_sklepu: sku, odczytane_at: '2026-11-01T08:00:00.000Z',
});

beforeEach(() => {
  db = openOmsDb(':memory:');
  karty = {
    k1: utworzKarte(db, { nazwa: 'Lampa Półcień 01', sku: 'PP-LAMPA-01' }),
    k3: utworzKarte(db, { nazwa: 'Abażur Półcień 03', sku: 'PP-STARY-03' }),
    k4: utworzKarte(db, { nazwa: 'Plafon Półcień 04', sku: 'PP-RECZNY-04', ean: '5900000000017' }),
  };
  // EAN karty k4 wpisany ręcznie — import nie ma prawa go nadpisać.
  db.prepare("INSERT INTO karty_zrodla_pol (karta_id, pole, zrodlo, reczne, zmieniono_at) VALUES (?, 'ean', 'reczne', 1, '2026-11-01T08:00:00.000Z')")
    .run(karty.k4);
  powiazProdukt(db, lustro('pro', '103', 'Abażur Półcień 03', 'PP-STARY-03'), karty.k3);
  powiazProdukt(db, lustro('pro', '104', 'Plafon Półcień 04', 'PP-RECZNY-04'), karty.k4);
  // Drugi sklep: niepowiązany produkt z wcześniejszego odczytu — „część" na „pro" nie może go ruszyć.
  lustro('swietlik', '501', 'Kubek Świetlik', 'SW-KUBEK-01');
  sklepy = {
    pro: { pobierzWszystkieProdukty: vi.fn(async () => KATALOG_PRO), pobierzWarianty: vi.fn(async () => []) },
    swietlik: { pobierzWszystkieProdukty: vi.fn(async () => [produktWoo(501, 'SW-KUBEK-01', 'Kubek Świetlik', null)]), pobierzWarianty: vi.fn(async () => []) },
  };
  allegro = { allegro_swietlik: { pobierzOferty: vi.fn(async () => OFERTY) } };
  tresc = {
    start: vi.fn(() => ({ wystartowal: true })),
    stan: () => ({ trwa: false, zaczety_at: null, skonczony_at: null, postep: null, razem: 0, pobrane: 0, bledy: [], blad: null }),
    gotowy: () => true,
  };
});

const serwer = (o = {}) => buildOmsServer({ db, config, sklepy, klienciWiadomosci: allegro,
  nadpisania: { 'magazyn.trescAllegro': tresc }, ...o });

async function sprawdz(app, kanal, typ) {
  const r = await app.inject({ method: 'POST', url: '/magazyn/import/sprawdz', headers: auth, payload: `kanal=${kanal}&typ=${typ}` });
  expect(r.statusCode).toBe(303);
  for (let i = 0; i < 200; i += 1) {
    const g = await app.inject({ method: 'GET', url: r.headers.location, headers: auth });
    expect(g.statusCode).toBe(200);
    if (g.body.includes('data-krok="podglad"')) return g.body;
    await new Promise((ok) => { setTimeout(ok, 5); });
  }
  throw new Error('podgląd się nie pojawił');
}
const importuj = (app, kanal, typ) => app.inject({ method: 'POST', url: '/magazyn/import/importuj', headers: auth, payload: `kanal=${kanal}&typ=${typ}` });
const liczba = (html, klucz) => Number(html.match(new RegExp(`data-liczba="${klucz}"[^>]*>(\\d+)<`))?.[1]);

describe('ekran wyboru', () => {
  it('kanały z plakietką, pięć typów radio, D3 przy Allegro, odnośnik do powiązań; stanów bez przełącznika nie ma', async () => {
    const r = await serwer().inject({ method: 'GET', url: '/magazyn/import', headers: auth });
    expect(r.statusCode).toBe(200);
    const html = r.body;
    expect(html).toMatch(/<form [^>]*action="\/magazyn\/import\/sprawdz"/);
    for (const kanal of ['pro', 'swietlik', 'allegro_swietlik']) expect(html).toMatch(new RegExp(`<input type="radio" name="kanal" value="${kanal}"`));
    // Konto bez klienta nie jest połączeniem — nie ma czego czytać.
    expect(html).not.toMatch(/name="kanal" value="allegro_polcien2"/);
    expect(html).toMatch(/plakietka plakietka--kanal plakietka--allegro/);
    expect(html).toMatch(/plakietka plakietka--kanal plakietka--woo/);
    for (const [klucz, napis] of Object.entries(TYPY)) {
      expect(html).toMatch(new RegExp(`<input type="radio" name="typ" value="${klucz}"`));
      expect(html).toContain(napis);
    }
    expect(html).toContain(ZDANIE_D3);
    expect(html).toMatch(/<a [^>]*href="https:\/\/help\.allegro\.com"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
    expect(html).toMatch(/<a [^>]*href="\/magazyn\/powiazania"[^>]*>Powiąż ręcznie oferty z kartami →<\/a>/);
    expect(html).not.toContain('Stany magazynowe z pliku');
  });

  it('stany włączone → odnośnik „Stany magazynowe z pliku →"', async () => {
    przelaczStany(db, { wlacz: true });
    const r = await serwer().inject({ method: 'GET', url: '/magazyn/import', headers: auth });
    expect(r.body).toMatch(/<a [^>]*href="\/magazyn\/stany\/import"[^>]*>Stany magazynowe z pliku →<\/a>/);
  });

  it('brak połączeń → zdanie z odnośnikiem do Ustawień, bez formularza', async () => {
    const app = buildOmsServer({ db, config: { ...config, sklepy: {}, kanaly: {} } });
    const r = await app.inject({ method: 'GET', url: '/magazyn/import', headers: auth });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Połącz sklep albo konto w Ustawieniach');
    expect(r.body).toMatch(/href="\/ustawienia\/integracje"/);
    expect(r.body).not.toMatch(/action="\/magazyn\/import\/sprawdz"/);
  });
});

describe('Sprawdź — podgląd', () => {
  it('czyta TYLKO wybrany kanał i nie zmienia kart (liczba i treść przed = po)', async () => {
    const app = serwer();
    const przed = { n: liczbaKart(), k1: kartaSql(karty.k1), k3: kartaSql(karty.k3), k4: kartaSql(karty.k4) };
    const html = await sprawdz(app, 'pro', 'pelny');
    expect(sklepy.pro.pobierzWszystkieProdukty).toHaveBeenCalledTimes(1);
    expect(sklepy.swietlik.pobierzWszystkieProdukty).not.toHaveBeenCalled();
    expect(allegro.allegro_swietlik.pobierzOferty).not.toHaveBeenCalled();
    expect({ n: liczbaKart(), k1: kartaSql(karty.k1), k3: kartaSql(karty.k3), k4: kartaSql(karty.k4) }).toEqual(przed);
    expect(wiersz('pro', '101').karta_id).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM zdjecia_kart').get().n).toBe(0);
    expect(liczba(html, 'powiaze')).toBe(1);
    expect(liczba(html, 'utworzy')).toBe(1);
    expect(liczba(html, 'zaktualizuje')).toBe(3);
    expect(html).toMatch(/href="\/magazyn\/pominiete\?kanal=pro"/);
    expect(html).toMatch(/<form [^>]*action="\/magazyn\/import\/importuj"/);
  });

  it('„Importuj" bez świeżego odczytu tego kanału → odmowa, nic nie zapisane', async () => {
    const app = serwer();
    await sprawdz(app, 'swietlik', 'czesc');
    const n = liczbaKart();
    const r = await importuj(app, 'pro', 'czesc');
    expect(r.statusCode).toBe(409);
    expect(r.body).toContain('Sprawdź');
    expect(liczbaKart()).toBe(n);
  });
});

describe('Importuj — pięć typów na sklepie „pro"', () => {
  it('„tylko powiąż": wiąże po SKU, nic nie tworzy, treści nie rusza', async () => {
    const app = serwer();
    await sprawdz(app, 'pro', 'powiaz');
    const n = liczbaKart();
    const r = await importuj(app, 'pro', 'powiaz');
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('data-krok="wynik"');
    expect(liczba(r.body, 'powiaze')).toBe(1);
    expect(liczbaKart()).toBe(n);
    expect(wiersz('pro', '101').karta_id).toBe(karty.k1);
    expect(wiersz('pro', '102').karta_id).toBeNull();
    expect(kartaSql(karty.k1).ean).toBeNull();
    expect(kartaSql(karty.k3).ean).toBeNull();
  });

  it('„część": wiąże i tworzy tylko z wybranego kanału — drugi sklep nietknięty, treść powiązanych bez zmian', async () => {
    const app = serwer();
    await sprawdz(app, 'pro', 'czesc');
    const n = liczbaKart();
    const r = await importuj(app, 'pro', 'czesc');
    expect(r.statusCode).toBe(200);
    expect(liczba(r.body, 'utworzy')).toBe(1);
    expect(liczbaKart()).toBe(n + 1);
    expect(wiersz('pro', '101').karta_id).toBe(karty.k1);
    const nowa = wiersz('pro', '102').karta_id;
    expect(nowa).not.toBeNull();
    expect(kartaSql(nowa).nazwa).toBe('Kinkiet Półcień 02');
    expect(wiersz('swietlik', '501').karta_id).toBeNull();
    expect(kartaSql(karty.k3).ean).toBeNull();
  });

  it('„pobierz nowe i zaktualizuj": wiąże, tworzy i aktualizuje treść; ręczne pole zostaje', async () => {
    const app = serwer();
    await sprawdz(app, 'pro', 'pelny');
    const r = await importuj(app, 'pro', 'pelny');
    expect(r.statusCode).toBe(200);
    expect(wiersz('pro', '101').karta_id).toBe(karty.k1);
    expect(wiersz('pro', '102').karta_id).not.toBeNull();
    expect(kartaSql(karty.k1).ean).toBe('5901234123457');
    expect(kartaSql(karty.k3).ean).toBe('5901234123464');
    expect(kartaSql(karty.k4).ean).toBe('5900000000017');
  });

  it('„tylko zaktualizuj": aktualizuje powiązane, nowych nie wiąże i nie tworzy; ręczne pole zostaje', async () => {
    const app = serwer();
    await sprawdz(app, 'pro', 'aktualizuj');
    const n = liczbaKart();
    const r = await importuj(app, 'pro', 'aktualizuj');
    expect(r.statusCode).toBe(200);
    expect(liczbaKart()).toBe(n);
    expect(wiersz('pro', '101').karta_id).toBeNull();
    expect(wiersz('pro', '102').karta_id).toBeNull();
    expect(kartaSql(karty.k3).ean).toBe('5901234123464');
    expect(kartaSql(karty.k4).ean).toBe('5900000000017');
    expect(kartaSql(karty.k1).ean).toBeNull();
  });

  it('„tylko nowe": tworzy z niepowiązanych, istniejących kart nie zmienia (ani treści, ani powiązań)', async () => {
    const app = serwer();
    await sprawdz(app, 'pro', 'nowe');
    const przed = { k1: kartaSql(karty.k1), k3: kartaSql(karty.k3), k4: kartaSql(karty.k4) };
    const n = liczbaKart();
    const r = await importuj(app, 'pro', 'nowe');
    expect(r.statusCode).toBe(200);
    expect(liczbaKart()).toBe(n + 1);
    const nowa = wiersz('pro', '102').karta_id;
    expect(kartaSql(nowa).ean).toBe('5901234123440');
    expect({ k1: kartaSql(karty.k1), k3: kartaSql(karty.k3), k4: kartaSql(karty.k4) }).toEqual(przed);
    // Karta o tym SKU już jest — „tylko nowe" nie robi z niej duplikatu.
    expect(wiersz('pro', '101').karta_id).toBeNull();
  });
});

describe('Importuj — konto Allegro', () => {
  it('„tylko powiąż" wiąże ofertę po SKU (external.id), ofertę bez SKU pomija; treści nie pobiera', async () => {
    const app = serwer();
    const html = await sprawdz(app, 'allegro_swietlik', 'powiaz');
    expect(html).toContain(ZDANIE_D3);
    expect(sklepy.pro.pobierzWszystkieProdukty).not.toHaveBeenCalled();
    const r = await importuj(app, 'allegro_swietlik', 'powiaz');
    expect(r.statusCode).toBe(200);
    expect(wiersz('allegro_swietlik', '7001').karta_id).toBe(karty.k1);
    expect(wiersz('allegro_swietlik', '7002').karta_id).toBeNull();
    expect(liczba(r.body, 'pominie')).toBe(1);
    expect(tresc.start).not.toHaveBeenCalled();
  });

  it('„tylko zaktualizuj" uruchamia odczyt treści zawężony do tego konta, nowych ofert nie wiąże', async () => {
    // 7001 zaimportowana wcześniej (powiązana z k1) — jej treść jest do odświeżenia; 7002 nowa, bez karty.
    powiazProdukt(db, lustro('allegro_swietlik', '7001', 'Lampa Półcień na Allegro', 'PP-LAMPA-01'), karty.k1);
    const app = serwer();
    const html = await sprawdz(app, 'allegro_swietlik', 'aktualizuj');
    expect(liczba(html, 'zaktualizuje')).toBe(1);
    const n = liczbaKart();
    const r = await importuj(app, 'allegro_swietlik', 'aktualizuj');
    expect(r.statusCode).toBe(200);
    expect(tresc.start).toHaveBeenCalledTimes(1);
    expect(tresc.start).toHaveBeenCalledWith({ kanaly: ['allegro_swietlik'] });
    expect(wiersz('allegro_swietlik', '7002').karta_id).toBeNull();
    expect(liczbaKart()).toBe(n);
  });
});

describe('ekran pominiętych zawężony do kanału', () => {
  it('?kanal= pokazuje tylko wiersze tego kanału', async () => {
    lustro('allegro_swietlik', '9001', 'Oferta Półcień bez karty', null);
    const app = serwer();
    const caly = await app.inject({ method: 'GET', url: '/magazyn/pominiete', headers: auth });
    expect(caly.body).toContain('Oferta Półcień bez karty');
    const pro = await app.inject({ method: 'GET', url: '/magazyn/pominiete?kanal=pro', headers: auth });
    expect(pro.statusCode).toBe(200);
    expect(pro.body).not.toContain('Oferta Półcień bez karty');
  });
});

describe('zawężenie przebiegów do jednego kanału (parametry opcjonalne)', () => {
  it('start({kanal}) czyta jeden kanał bez treści kart; start() bez zmian', async () => {
    const odswiez = vi.fn(async () => ({ kanaly: [] }));
    const p = createMagazynPrzebieg({ db, sklepy: { a: {}, b: {} }, allegro: { c: {} }, odswiez, kanalySklepow: ['a', 'b'], kanalyAllegro: ['c'] });
    expect(p.kanaly()).toEqual(['a', 'b', 'c']);
    expect(p.start({ kanal: 'x' })).toEqual({ wystartowal: false });
    expect(p.start({ kanal: 'b', trescKart: false })).toEqual({ wystartowal: true });
    expect(odswiez.mock.calls[0][0]).toMatchObject({ sklepy: { b: {} }, allegro: {}, trescKart: false });
    expect(Object.keys(odswiez.mock.calls[0][0].sklepy)).toEqual(['b']);
    expect(p.stan().zakres).toBe('b');
    await vi.waitFor(() => expect(p.stan().trwa).toBe(false));
    p.start();
    expect(Object.keys(odswiez.mock.calls[1][0].sklepy)).toEqual(['a', 'b']);
    expect(Object.keys(odswiez.mock.calls[1][0].allegro)).toEqual(['c']);
    expect(odswiez.mock.calls[1][0].trescKart).toBeUndefined();
    expect(p.stan().zakres).toBeNull();
  });

  it('kolejka treści Allegro zawężona do kart; start({kanaly}) pyta tylko to konto', async () => {
    const a = powiazProdukt(db, lustro('allegro_a', '1', 'Oferta A', null), karty.k1);
    void a;
    powiazProdukt(db, lustro('allegro_a', '2', 'Oferta A2', null), karty.k3);
    powiazProdukt(db, lustro('allegro_b', '3', 'Oferta B', null), karty.k3);
    expect(kolejka(db, ['allegro_a', 'allegro_b']).map(w => w.produkt_id)).toEqual(['1', '2', '3']);
    expect(kolejka(db, ['allegro_a', 'allegro_b'], null, [karty.k3]).map(w => w.produkt_id)).toEqual(['2', '3']);
    const klient = () => ({ pobierzOferte: vi.fn(async () => null) });
    const kl = { allegro_a: klient(), allegro_b: klient() };
    const p = createTrescAllegroPrzebieg({ db, allegro: kl, kanalyAllegro: ['allegro_a', 'allegro_b'] });
    expect(p.start({ kanaly: ['allegro_b'] })).toEqual({ wystartowal: true });
    await vi.waitFor(() => expect(p.stan().trwa).toBe(false));
    expect(kl.allegro_a.pobierzOferte).not.toHaveBeenCalled();
    expect(kl.allegro_b.pobierzOferte).toHaveBeenCalledWith('3');
  });
});

describe('dwa wiersze kanału z tym samym SKU, karty o tym SKU nie ma (uwaga recenzji P3b.03a)', () => {
  for (const klucz of ['czesc', 'nowe']) {
    it(`„${klucz}": plan = wynik, oba wiersze na jednej nowej karcie, drugi podgląd nic nie tworzy`, () => {
      const typ = typImportu(klucz);
      const p = { kanal: 'pro', typ, kanalyZrodlowe: ['pro', 'swietlik'], allegro: false };
      lustro('pro', '201', 'Kinkiet Półcień 09', 'PP-DUBEL-09');
      lustro('pro', '202', 'Kinkiet Półcień 09 (drugi wpis)', 'PP-DUBEL-09');
      const powiazanych = () => db.prepare("SELECT COUNT(*) AS n FROM produkty_sklepowe WHERE kanal = 'pro' AND karta_id IS NOT NULL").get().n;
      const plan = planImportu(db, p);
      expect(plan.liczby).toMatchObject({ utworzy: 1, powiaze: 1, pominie: 0 });
      const n = liczbaKart();
      const przed = powiazanych();
      const wynik = wykonajImport(db, p);
      expect(wynik.liczby).toEqual(plan.liczby);
      expect(liczbaKart()).toBe(n + plan.liczby.utworzy);
      expect(powiazanych()).toBe(przed + plan.liczby.utworzy + plan.liczby.powiaze);
      const a = wiersz('pro', '201').karta_id;
      expect(a).not.toBeNull();
      expect(wiersz('pro', '202').karta_id).toBe(a);
      expect(planImportu(db, p).liczby).toMatchObject({ utworzy: 0, powiaze: 0, pominie: 0 });
    });
  }
});

describe('stan treści Allegro po imporcie (uwaga recenzji P3b.03a)', () => {
  const p = () => ({ kanal: 'allegro_swietlik', typ: typImportu('aktualizuj'), kanalyZrodlowe: ['pro', 'swietlik'], allegro: true });
  beforeEach(() => {
    powiazProdukt(db, lustro('allegro_swietlik', '7001', 'Lampa Półcień 01', 'PP-LAMPA-01'), karty.k1);
  });
  it('przebieg treści zajęty (trwa) → „zajeta"', () => {
    const t = { gotowy: () => true, stan: () => ({ trwa: true }), start: vi.fn(() => ({ wystartowal: false })) };
    expect(wykonajImport(db, { ...p(), trescAllegro: t }).trescAllegro).toBe('zajeta');
  });
  it('konto bez odczytu ofert (gotowy() = false) → „niedostepna", nie „zajeta"; start nie woła', () => {
    const t = { gotowy: () => false, stan: () => ({ trwa: false }), start: vi.fn(() => ({ wystartowal: false })) };
    expect(wykonajImport(db, { ...p(), trescAllegro: t }).trescAllegro).toBe('niedostepna');
    expect(t.start).not.toHaveBeenCalled();
  });
});
