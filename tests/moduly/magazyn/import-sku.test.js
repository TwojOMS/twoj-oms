import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { zapiszProduktSklepowy, powiazProdukt, utworzKarte } from '../../../src/oms/db/magazyn.js';
import { typImportu, planImportu, wykonajImport } from '../../../src/moduly/magazyn/services/import-kanalu.js';

// Import drugiego kanału widzi kartę założoną z pierwszego: szukanie po SKU najpierw
// w `karty_produktow.sku`, potem w powiązanych wierszach lustra (jedna karta), a karta zakładana przez import
// dostaje SKU z wiersza. Dane zmyślone („Pracownia Półcień”).

const POWOD_KILKA = 'kilka kart z tym SKU — powiąż ręcznie';
const ZRODLOWE = ['pro', 'swietlik'];

let db;
const kartaSql = (id) => db.prepare('SELECT * FROM karty_produktow WHERE id = ?').get(id);
const liczbaKart = () => db.prepare('SELECT COUNT(*) AS n FROM karty_produktow').get().n;
const wiersz = (kanal, produktId) =>
  db.prepare('SELECT * FROM produkty_sklepowe WHERE kanal = ? AND produkt_id = ?').get(kanal, produktId);
const lustro = (kanal, produktId, nazwa, sku) =>
  zapiszProduktSklepowy(db, {
    kanal,
    produkt_id: produktId,
    wariant_id: '',
    nazwa,
    sku_sklepu: sku,
    odczytane_at: '2026-11-01T08:00:00.000Z',
  });
const p = (kanal, klucz, allegro = kanal.startsWith('allegro')) => ({
  kanal,
  typ: typImportu(klucz),
  kanalyZrodlowe: ZRODLOWE,
  allegro,
});

beforeEach(() => {
  db = openOmsDb(':memory:');
});

describe('drugi kanał z tym samym SKU wiąże się z istniejącą kartą', () => {
  it('Woo zakłada kartę X (z SKU), potem Allegro X → powiaze 1, utworzy 0, ta sama karta', () => {
    lustro('pro', '101', 'Lampa Półcień 01', 'PP-LAMPA-01');
    const woo = wykonajImport(db, p('pro', 'czesc'));
    expect(woo.liczby).toMatchObject({ utworzy: 1, powiaze: 0 });
    const k = wiersz('pro', '101').karta_id;
    expect(kartaSql(k).sku).toBe('PP-LAMPA-01');

    lustro('allegro_swietlik', '7001', 'Lampa Półcień na Allegro', 'PP-LAMPA-01');
    const plan = planImportu(db, p('allegro_swietlik', 'czesc'));
    expect(plan.liczby).toMatchObject({ powiaze: 1, utworzy: 0, pominie: 0 });
    const n = liczbaKart();
    const wynik = wykonajImport(db, p('allegro_swietlik', 'czesc'));
    expect(wynik.liczby).toEqual(plan.liczby);
    expect(liczbaKart()).toBe(n);
    expect(wiersz('allegro_swietlik', '7001').karta_id).toBe(k);
  });

  it('karta bez SKU powiązana z wierszem Woo X → Allegro X wiąże się z nią przez lustro', () => {
    const k = utworzKarte(db, { nazwa: 'Kinkiet Półcień 02' });
    powiazProdukt(db, lustro('pro', '102', 'Kinkiet Półcień 02', 'PP-KINKIET-02'), k);
    lustro('allegro_swietlik', '7002', 'Kinkiet na Allegro', 'PP-KINKIET-02');
    const plan = planImportu(db, p('allegro_swietlik', 'czesc'));
    expect(plan.liczby).toMatchObject({ powiaze: 1, utworzy: 0, pominie: 0 });
    const n = liczbaKart();
    expect(wykonajImport(db, p('allegro_swietlik', 'czesc')).liczby).toEqual(plan.liczby);
    expect(liczbaKart()).toBe(n);
    expect(wiersz('allegro_swietlik', '7002').karta_id).toBe(k);
  });

  it('SKU ze spacjami na końcu (lustro i nowy wiersz) → to samo powiązanie', () => {
    const k = utworzKarte(db, { nazwa: 'Plafon Półcień 03' });
    powiazProdukt(db, lustro('pro', '103', 'Plafon Półcień 03', 'PP-PLAFON-03  '), k);
    lustro('allegro_swietlik', '7003', 'Plafon na Allegro', ' PP-PLAFON-03 ');
    const plan = planImportu(db, p('allegro_swietlik', 'powiaz'));
    expect(plan.liczby).toMatchObject({ powiaze: 1, utworzy: 0, pominie: 0 });
    wykonajImport(db, p('allegro_swietlik', 'powiaz'));
    expect(wiersz('allegro_swietlik', '7003').karta_id).toBe(k);
  });

  it('dwie różne karty z tym SKU w lustrze → pominięcie z powodem, nic nie wiąże i nie tworzy', () => {
    const a = utworzKarte(db, { nazwa: 'Abażur Półcień A' });
    const b = utworzKarte(db, { nazwa: 'Abażur Półcień B' });
    powiazProdukt(db, lustro('pro', '104', 'Abażur A', 'PP-ABAZUR-04'), a);
    powiazProdukt(db, lustro('swietlik', '504', 'Abażur B', 'PP-ABAZUR-04'), b);
    lustro('allegro_swietlik', '7004', 'Abażur na Allegro', 'PP-ABAZUR-04');
    for (const klucz of ['powiaz', 'czesc', 'pelny']) {
      const plan = planImportu(db, p('allegro_swietlik', klucz));
      expect(plan.liczby).toMatchObject({ powiaze: 0, utworzy: 0, pominie: 1 });
      expect(plan.powody).toEqual([{ powod: POWOD_KILKA, ile: 1 }]);
    }
    const n = liczbaKart();
    const wynik = wykonajImport(db, p('allegro_swietlik', 'czesc'));
    expect(wynik.powody).toEqual([{ powod: POWOD_KILKA, ile: 1 }]);
    expect(liczbaKart()).toBe(n);
    expect(wiersz('allegro_swietlik', '7004').karta_id).toBeNull();
  });

  it('karta z ręcznym innym SKU, znaleziona przez lustro, nie traci go', () => {
    const k = utworzKarte(db, { nazwa: 'Lampa Półcień 05', sku: 'RECZNE-05' });
    powiazProdukt(db, lustro('pro', '105', 'Lampa Półcień 05', 'PP-LAMPA-05'), k);
    lustro('allegro_swietlik', '7005', 'Lampa 05 na Allegro', 'PP-LAMPA-05');
    const wynik = wykonajImport(db, p('allegro_swietlik', 'pelny'));
    expect(wynik.liczby).toMatchObject({ powiaze: 1, utworzy: 0 });
    expect(wiersz('allegro_swietlik', '7005').karta_id).toBe(k);
    expect(kartaSql(k).sku).toBe('RECZNE-05');
  });

  it('SKU z twardą spacją (NBSP) w lustrze → ten sam trim co w imporcie, to samo powiązanie', () => {
    const k = utworzKarte(db, { nazwa: 'Kinkiet Półcień 07' });
    powiazProdukt(db, lustro('pro', '107', 'Kinkiet Półcień 07', 'PP-KINKIET-07 '), k);
    lustro('allegro_swietlik', '7007', 'Kinkiet 07 na Allegro', ' PP-KINKIET-07');
    expect(planImportu(db, p('allegro_swietlik', 'powiaz')).liczby).toMatchObject({ powiaze: 1, pominie: 0 });
    wykonajImport(db, p('allegro_swietlik', 'powiaz'));
    expect(wiersz('allegro_swietlik', '7007').karta_id).toBe(k);
  });

  it('zniknięty wiersz lustra K1 + żywy K2 → żywy wygrywa (K2), bez pominięcia', () => {
    const k1 = utworzKarte(db, { nazwa: 'Lampa stara 08' });
    const k2 = utworzKarte(db, { nazwa: 'Lampa Półcień 08' });
    const stary = lustro('swietlik', '508', 'Lampa stara 08', 'PP-LAMPA-08');
    powiazProdukt(db, stary, k1);
    db.prepare("UPDATE produkty_sklepowe SET zniknal_at = '2026-11-02T08:00:00.000Z' WHERE id = ?").run(stary);
    powiazProdukt(db, lustro('pro', '108', 'Lampa Półcień 08', 'PP-LAMPA-08'), k2);
    lustro('allegro_swietlik', '7008', 'Lampa 08 na Allegro', 'PP-LAMPA-08');
    expect(planImportu(db, p('allegro_swietlik', 'czesc')).liczby).toMatchObject({
      powiaze: 1,
      utworzy: 0,
      pominie: 0,
    });
    wykonajImport(db, p('allegro_swietlik', 'czesc'));
    expect(wiersz('allegro_swietlik', '7008').karta_id).toBe(k2);
  });

  it('tylko zniknięte wiersze lustra z jedną kartą → ta karta; z dwiema → pominięcie', () => {
    const k = utworzKarte(db, { nazwa: 'Plafon stary 09' });
    const w1 = lustro('swietlik', '509', 'Plafon stary 09', 'PP-PLAFON-09');
    powiazProdukt(db, w1, k);
    db.prepare("UPDATE produkty_sklepowe SET zniknal_at = '2026-11-02T08:00:00.000Z' WHERE id = ?").run(w1);
    lustro('allegro_swietlik', '7009', 'Plafon 09 na Allegro', 'PP-PLAFON-09');
    expect(planImportu(db, p('allegro_swietlik', 'czesc')).liczby).toMatchObject({ powiaze: 1, utworzy: 0 });
    const w2 = lustro('pro', '109', 'Plafon inny 09', 'PP-PLAFON-09');
    powiazProdukt(db, w2, utworzKarte(db, { nazwa: 'Plafon inny 09' }));
    db.prepare("UPDATE produkty_sklepowe SET zniknal_at = '2026-11-02T08:00:00.000Z' WHERE id = ?").run(w2);
    const plan = planImportu(db, p('allegro_swietlik', 'czesc'));
    expect(plan.liczby).toMatchObject({ powiaze: 0, utworzy: 0, pominie: 1 });
    expect(plan.powody).toEqual([{ powod: POWOD_KILKA, ile: 1 }]);
  });

  it('karta z SKU w karty_produktow ma pierwszeństwo przed lustrem innej karty', () => {
    const zSku = utworzKarte(db, { nazwa: 'Kubek Półcień', sku: 'PP-KUBEK-06' });
    const inna = utworzKarte(db, { nazwa: 'Kubek stary' });
    powiazProdukt(db, lustro('pro', '106', 'Kubek stary', 'PP-KUBEK-06'), inna);
    lustro('allegro_swietlik', '7006', 'Kubek na Allegro', 'PP-KUBEK-06');
    expect(planImportu(db, p('allegro_swietlik', 'czesc')).liczby).toMatchObject({ powiaze: 1, pominie: 0 });
    wykonajImport(db, p('allegro_swietlik', 'czesc'));
    expect(wiersz('allegro_swietlik', '7006').karta_id).toBe(zSku);
  });
});

describe('podgląd („Sprawdź”) = wynik („Importuj”) przez ekran', () => {
  const config = { auth: { user: 'adam', pass: 'x' } };
  const auth = {
    authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`,
    origin: 'http://localhost',
    'content-type': 'application/x-www-form-urlencoded',
  };
  const liczba = (html, klucz) => Number(html.match(new RegExp(`data-liczba="${klucz}"[^>]*>(\\d+)<`))?.[1]);
  async function sprawdz(app, kanal, typ) {
    const r = await app.inject({
      method: 'POST',
      url: '/magazyn/import/sprawdz',
      headers: auth,
      payload: `kanal=${kanal}&typ=${typ}`,
    });
    expect(r.statusCode).toBe(303);
    for (let i = 0; i < 200; i += 1) {
      const g = await app.inject({ method: 'GET', url: r.headers.location, headers: auth });
      if (g.body.includes('data-krok="podglad"')) return g.body;
      await new Promise((ok) => {
        setTimeout(ok, 5);
      });
    }
    throw new Error('podgląd się nie pojawił');
  }

  it('Woo „część” zakłada kartę, Allegro z tym SKU: podgląd i wynik pokazują powiąże 1, utworzy 0', async () => {
    const produkt = {
      id: 201,
      name: 'Lampa Półcień 21',
      sku: 'PP-LAMPA-21',
      type: 'simple',
      description: '',
      images: [],
      categories: [],
      attributes: [],
    };
    const oferty = [
      {
        id: '7021',
        name: 'Lampa 21 na Allegro',
        external: { id: 'PP-LAMPA-21' },
        sellingMode: { price: { amount: '99.00', currency: 'PLN' } },
      },
      {
        id: '7022',
        name: 'Lampa 22 na Allegro',
        external: { id: 'PP-LAMPA-22' },
        sellingMode: { price: { amount: '99.00', currency: 'PLN' } },
      },
    ];
    // Dwie karty z SKU PP-LAMPA-22 w lustrze sklepu „swietlik” — oferta 7022 ma zostać pominięta z powodem.
    for (const [id, nazwa] of [
      ['521', 'Lampa 22 A'],
      ['522', 'Lampa 22 B'],
    ]) {
      powiazProdukt(db, lustro('swietlik', id, nazwa, 'PP-LAMPA-22'), utworzKarte(db, { nazwa }));
    }
    const sklepy = {
      pro: { pobierzWszystkieProdukty: vi.fn(async () => [produkt]), pobierzWarianty: vi.fn(async () => []) },
    };
    const tresc = { start: vi.fn(() => ({ wystartowal: true })), stan: () => ({ trwa: false }), gotowy: () => true };
    const app = buildOmsServer({
      db,
      config,
      sklepy,
      klienciWiadomosci: { allegro_swietlik: { pobierzOferty: vi.fn(async () => oferty) } },
      nadpisania: { 'magazyn.trescAllegro': tresc },
    });

    await sprawdz(app, 'pro', 'czesc');
    await app.inject({
      method: 'POST',
      url: '/magazyn/import/importuj',
      headers: auth,
      payload: 'kanal=pro&typ=czesc',
    });
    const k = wiersz('pro', '201').karta_id;
    expect(k).not.toBeNull();

    const podglad = await sprawdz(app, 'allegro_swietlik', 'czesc');
    const r = await app.inject({
      method: 'POST',
      url: '/magazyn/import/importuj',
      headers: auth,
      payload: 'kanal=allegro_swietlik&typ=czesc',
    });
    expect(r.statusCode).toBe(200);
    for (const [klucz, ile] of Object.entries({ powiaze: 1, utworzy: 0, pominie: 1 })) {
      expect(liczba(podglad, klucz)).toBe(ile);
      expect(liczba(r.body, klucz)).toBe(ile);
    }
    expect(podglad).toContain(POWOD_KILKA);
    expect(r.body).toContain(POWOD_KILKA);
    expect(wiersz('allegro_swietlik', '7021').karta_id).toBe(k);
    expect(wiersz('allegro_swietlik', '7022').karta_id).toBeNull();
  });
});
