import { afterEach, expect, it, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import {
  utworzKarte,
  zapiszKarte,
  zastosujHurtem,
  zapiszProduktSklepowy,
  powiazProdukt,
} from '../../../src/oms/db/magazyn.js';
import { odswiezMagazyn } from '../../../src/moduly/magazyn/services/magazyn-sync.js';
import { createAtrapaWoo } from '../../../deploy/proba/atrapy/kanaly.mjs';

const AT = '2026-11-12T12:00:00.000Z';
const bazy = [];
afterEach(() => {
  for (const db of bazy.splice(0)) db.close();
});
const produkt = (p = {}) => ({
  id: 80,
  name: 'Lampa Pracowni Półcień',
  type: 'simple',
  description: '<h3>Lampa lniana</h3><p>Ciepłe światło.</p>',
  short_description: '<p>Krótki opis lampy</p>',
  global_unique_id: '5900000000016',
  price: '69.00',
  regular_price: '99.00',
  sale_price: '69.00',
  images: [1, 2, 3].map((n) => ({ src: `https://polcien.example.invalid/lampa-${n}.jpg` })),
  categories: [{ id: 4, name: 'Lampy wiszące' }],
  stock_quantity: 9,
  ...p,
});

function baza(warianty = ['']) {
  const db = openOmsDb(':memory:');
  bazy.push(db);
  for (const wariant_id of warianty) {
    const id = utworzKarte(db, { nazwa: 'Lampa Pracowni Półcień' });
    const pid = zapiszProduktSklepowy(db, {
      kanal: 'polcien',
      produkt_id: '80',
      wariant_id,
      nazwa: 'Lampa',
      odczytane_at: AT,
    });
    powiazProdukt(db, pid, id);
  }
  return db;
}
async function odczyt(db, p = produkt(), { warianty = [], podatki = 'yes', liczyPodatki = 'yes', at = AT } = {}) {
  const log = vi.fn();
  const klient = {
    pobierzWszystkieProdukty: vi.fn(async () => [p]),
    pobierzWarianty: vi.fn(async () => warianty),
    ustawienieSklepu: vi.fn(async (id) => {
      if (id === 'woocommerce_prices_include_tax') return podatki;
      if (id === 'woocommerce_calc_taxes') {
        if (liczyPodatki instanceof Error) throw liczyPodatki;
        return liczyPodatki;
      }
      return null;
    }),
  };
  const wynik = await odswiezMagazyn({
    db,
    sklepy: { polcien: klient },
    kanalySklepow: ['polcien'],
    kanalyAllegro: [],
    teraz: () => at,
    log,
  });
  expect(wynik.kanaly[0].blad).toBeNull();
  expect(klient.pobierzWszystkieProdukty).toHaveBeenCalledTimes(1);
  expect(klient.ustawienieSklepu).toHaveBeenCalledWith('woocommerce_prices_include_tax', 'tax');
  return { log, klient };
}
const karta = (db) => db.prepare('SELECT * FROM karty_produktow ORDER BY id').get();

it('atrapa demo Półcień nie liczy podatków i ma ceny bez doliczania VAT', async () => {
  const klient = createAtrapaWoo({ db: baza(), kanal: 'polcien', env: { OMS_TRYB: 'proba' } });
  expect(await klient.ustawienieSklepu('woocommerce_calc_taxes', 'general')).toBe('no');
  expect(await klient.ustawienieSklepu('woocommerce_prices_include_tax', 'tax')).toBe('no');
});

it.each(['no', 'yes'])(
  'sklep bez podatków: cena regularna trafia na kartę przy prices_include_tax = %s',
  async (podatki) => {
    const db = baza();
    const { log } = await odczyt(db, produkt(), { liczyPodatki: 'no', podatki });
    expect(karta(db).cena_gr).toBe(9900);
    expect(log.mock.calls.flat().join(' ')).not.toContain('cena karty pusta');
  },
);

it.each(['no', 'yes'])('sklep liczy VAT, prices_include_tax = %s: cena i ostrzeżenie raz na kanał', async (podatki) => {
  const db = baza(['81', '82']);
  const { log, klient } = await odczyt(db, produkt({ type: 'variable' }), {
    liczyPodatki: 'yes',
    podatki,
    warianty: [81, 82].map((id) => ({ id, parent_id: 80, regular_price: '99.00' })),
  });
  expect(db.prepare('SELECT cena_gr FROM karty_produktow ORDER BY id').all()).toEqual(
    [81, 82].map(() => ({ cena_gr: podatki === 'yes' ? 9900 : null })),
  );
  const ostrzezenia = log.mock.calls.filter((args) => args.join(' ').includes('cena karty pusta'));
  expect(ostrzezenia).toHaveLength(podatki === 'yes' ? 0 : 1);
  if (podatki === 'no') expect(ostrzezenia[0][0]).toContain('sklep liczy VAT z cenami netto albo brak potwierdzenia');
  for (const [id, grupa] of [
    ['woocommerce_calc_taxes', 'general'],
    ['woocommerce_prices_include_tax', 'tax'],
  ]) {
    expect(klient.ustawienieSklepu.mock.calls.filter((args) => args[0] === id)).toEqual([[id, grupa]]);
  }
});

it.each(['no', 'yes'])(
  'błąd calc_taxes zachowuje dotychczasową regułę dla prices_include_tax = %s',
  async (podatki) => {
    const db = baza();
    const { log } = await odczyt(db, produkt(), { liczyPodatki: new Error('odmowa odczytu podatków'), podatki });
    expect(karta(db).cena_gr).toBe(podatki === 'yes' ? 9900 : null);
    expect(log.mock.calls.flat().join(' ')).toContain('odmowa odczytu podatków');
  },
);

it('identyczny odczyt nie zapisuje pól ani galerii; import nie odświeża starych pól', async () => {
  const db = baza();
  await odczyt(db);
  const przed = karta(db);
  const zdjecia = db.prepare('SELECT * FROM zdjecia_kart ORDER BY id').all();
  const zrodla = db.prepare('SELECT * FROM karty_zrodla_pol ORDER BY pole').all();
  await odczyt(db, produkt({ name: 'Inna nazwa', weight: '5', dimensions: { width: '20' } }), {
    at: '2026-11-12T13:00:00.000Z',
  });
  expect(karta(db)).toEqual(przed);
  expect(db.prepare('SELECT * FROM zdjecia_kart ORDER BY id').all()).toEqual(zdjecia);
  expect(db.prepare('SELECT * FROM karty_zrodla_pol ORDER BY pole').all()).toEqual(zrodla);
  expect(karta(db)).toMatchObject({ opis: null, kategoria_glowna: null, waga_g: null, szerokosc_mm: null });
});

it('zmiana galerii zachowuje pliki i odnośniki innego źródła', async () => {
  const db = baza();
  await odczyt(db);
  db.prepare(
    `INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, adres_zrodlowy, plik, sha256, typ, rozmiar, utworzono_at)
    VALUES (1, 10, 'woo:polcien', 'https://polcien.example.invalid/plik.jpg', 'plik.jpg', ?, 'image/jpeg', 10, ?)`,
  ).run('a'.repeat(64), AT);
  db.prepare(
    `INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, adres_zrodlowy, utworzono_at)
    VALUES (1, 11, 'inne', 'https://polcien.example.invalid/inne.jpg', ?)`,
  ).run(AT);
  const zachowane = db.prepare('SELECT * FROM zdjecia_kart WHERE kolejnosc >= 10 ORDER BY id').all();
  await odczyt(db, produkt({ images: [...produkt().images].reverse() }));
  expect(db.prepare('SELECT * FROM zdjecia_kart WHERE kolejnosc >= 10 ORDER BY id').all()).toEqual(zachowane);
  expect(
    db
      .prepare(
        "SELECT adres_zrodlowy FROM zdjecia_kart WHERE plik IS NULL AND zrodlo = 'woo:polcien' ORDER BY kolejnosc",
      )
      .all(),
  ).toEqual([...produkt().images].reverse().map((z) => ({ adres_zrodlowy: z.src })));
});

it.each(['pojedynczo', 'hurtem'])(
  'ręczny zapis %s oznacza tylko zmienione pola i chroni je przed Woo',
  async (tryb) => {
    const db = baza();
    await odczyt(db);
    const zmiany = { opis: 'Ręczny opis', cena_gr: 123, ean: karta(db).ean };
    if (tryb === 'hurtem') zastosujHurtem(db, [{ id: 1, zmiany }], { at: AT });
    else zapiszKarte(db, 1, zmiany, { at: AT });
    expect(
      db
        .prepare('SELECT pole, zrodlo, reczne, zmieniono_at FROM karty_zrodla_pol WHERE reczne = 1 ORDER BY pole')
        .all(),
    ).toEqual(['cena_gr', 'opis'].map((pole) => ({ pole, zrodlo: 'reczne', reczne: 1, zmieniono_at: AT })));
    await odczyt(db, produkt({ regular_price: '200', description: '<p>Inny opis</p>' }));
    expect(karta(db)).toMatchObject({ opis: 'Ręczny opis', cena_gr: 123 });
  },
);

it('zapis tej samej wartości według typu kolumny nie tworzy źródła ani daty', () => {
  const db = baza();
  const przed = karta(db);
  zapiszKarte(db, 1, { nazwa: przed.nazwa, cena_gr: null }, { at: AT });
  zastosujHurtem(db, [{ id: 1, zmiany: { nazwa: przed.nazwa } }], { at: AT });
  expect(db.prepare('SELECT * FROM karty_zrodla_pol').all()).toEqual([]);
  expect(karta(db)).toEqual(przed);
  zapiszKarte(db, 1, { cena_gr: 123 }, { at: AT });
  zapiszKarte(db, 1, { cena_gr: '123' }, { at: '2026-11-12T14:00:00.000Z' });
  expect(karta(db).zmieniony_at).toBe(AT);
});

it('opis wariantu wygrywa z rodzicem, pusty HTML przechodzi do krótkiego opisu', async () => {
  const db = baza(['81']);
  await odczyt(db, produkt({ type: 'variable' }), { warianty: [{ id: 81, description: '<p>Opis wariantu</p>' }] });
  expect(karta(db).opis_sekcje_json).toContain('Opis wariantu');
  await odczyt(db, produkt({ type: 'variable', description: '<p></p>' }), {
    warianty: [{ id: 81, description: '<p></p>' }],
  });
  expect(karta(db).opis_sekcje_json).toContain('Krótki opis lampy');
});

it('błąd oznaczenia ręcznego cofa również zapis karty i hurt', () => {
  const db = baza();
  const przed = karta(db);
  db.exec(
    `CREATE TRIGGER odmowa_zrodla BEFORE INSERT ON karty_zrodla_pol BEGIN SELECT RAISE(ABORT, 'odmowa testowa'); END`,
  );
  expect(() => zapiszKarte(db, 1, { opis: 'nowy' })).toThrow('odmowa testowa');
  expect(karta(db)).toEqual(przed);
  expect(() => zastosujHurtem(db, [{ id: 1, zmiany: { opis: 'nowy' } }])).toThrow('odmowa testowa');
  expect(karta(db)).toEqual(przed);
});

it('odczytuje pełny opis, wyłącznie EAN global_unique_id, cenę regularną i źródła pól', async () => {
  const db = baza();
  await odczyt(db);
  expect(JSON.parse(karta(db).opis_sekcje_json).sekcje).toEqual([
    { elementy: [{ typ: 'tekst', html: '<h2>Lampa lniana</h2><p>Ciepłe światło.</p>' }] },
  ]);
  expect(karta(db)).toMatchObject({ ean: '5900000000016', cena_gr: 9900, stawka_vat: null });
  expect(db.prepare("SELECT zrodlo, reczne FROM karty_zrodla_pol WHERE pole = 'cena_gr'").get()).toEqual({
    zrodlo: 'woo:polcien',
    reczne: 0,
  });
  expect(db.prepare('SELECT cena_gr FROM produkty_sklepowe').get().cena_gr).toBe(6900);
});

it('krótki opis zastępuje pusty długi, EAN z metadanych wtyczki jest ignorowany', async () => {
  const db = baza();
  await odczyt(
    db,
    produkt({ description: '', global_unique_id: '', meta_data: [{ key: '_woosea_ean', value: '5900000000023' }] }),
  );
  expect(karta(db).ean).toBeNull();
  expect(karta(db).opis_sekcje_json).toContain('Krótki opis lampy');
});

it('dwa warianty mają tę samą grupę rodzica i swoje ceny oraz EAN', async () => {
  const db = baza(['81', '82']);
  await odczyt(db, produkt({ type: 'variable' }), {
    warianty: [81, 82].map((id) => ({
      id,
      parent_id: 80,
      price: '50',
      regular_price: String(id),
      global_unique_id: String(id),
      attributes: [{ name: 'Kolor', option: String(id) }],
    })),
  });
  expect(db.prepare('SELECT grupa_wariantow, cena_gr, ean FROM karty_produktow ORDER BY id').all()).toEqual([
    { grupa_wariantow: 'woo:polcien:80', cena_gr: 8100, ean: '81' },
    { grupa_wariantow: 'woo:polcien:80', cena_gr: 8200, ean: '82' },
  ]);
});

it.each(['no', null])('ceny netto albo nieznane (%s): pusta cena i ostrzeżenie', async (podatki) => {
  const db = baza();
  const { log } = await odczyt(db, produkt(), { podatki });
  expect(karta(db).cena_gr).toBeNull();
  expect(log.mock.calls.flat().join(' ')).toMatch(/cena.*(netto|brutto)/i);
});

it('chroni pola ręczne, zastane, obce i bez źródła; aktualizuje własne źródło', async () => {
  const db = baza();
  await odczyt(db);
  db.prepare(
    "UPDATE karty_produktow SET ean = 'ręczny', cena_gr = 123, opis_sekcje_json = 'zastany', grupa_wariantow = 'bez źródła'",
  ).run();
  db.prepare("UPDATE karty_zrodla_pol SET reczne = 1 WHERE pole = 'ean'").run();
  db.prepare("UPDATE karty_zrodla_pol SET zrodlo = 'zastane', reczne = 1 WHERE pole = 'opis_sekcje_json'").run();
  db.prepare("UPDATE karty_zrodla_pol SET zrodlo = 'woo:inny' WHERE pole = 'cena_gr'").run();
  await odczyt(db, produkt({ global_unique_id: 'nowy', description: '<p>Nowy opis lampy</p>' }));
  expect(karta(db)).toMatchObject({
    ean: 'ręczny',
    cena_gr: 123,
    opis_sekcje_json: 'zastany',
    grupa_wariantow: 'bez źródła',
  });
  db.prepare("UPDATE karty_zrodla_pol SET zrodlo = 'woo:polcien' WHERE pole = 'cena_gr'").run();
  await odczyt(db, produkt({ regular_price: '120' }));
  expect(karta(db).cena_gr).toBe(12000);
  db.prepare("UPDATE karty_produktow SET ean = ''").run();
  await odczyt(db);
  expect(karta(db).ean).toBe('');
});

it('galeria to trzy odnośniki w kolejności; kolejne odczyty nie dublują, limit wynosi 20', async () => {
  const db = baza();
  await odczyt(db);
  await odczyt(db);
  expect(db.prepare('SELECT kolejnosc, adres_zrodlowy, plik FROM zdjecia_kart ORDER BY kolejnosc').all()).toEqual(
    produkt().images.map((z, kolejnosc) => ({ kolejnosc, adres_zrodlowy: z.src, plik: null })),
  );
  await odczyt(
    db,
    produkt({ images: Array.from({ length: 24 }, (_, n) => ({ src: `https://polcien.example.invalid/${n}.jpg` })) }),
  );
  expect(db.prepare('SELECT count(*) n FROM zdjecia_kart').get().n).toBe(20);
  db.prepare("UPDATE karty_zrodla_pol SET reczne = 1 WHERE pole = 'zdjecia'").run();
  await odczyt(db);
  expect(db.prepare('SELECT count(*) n FROM zdjecia_kart').get().n).toBe(20);
});

it('zapisuje kategorię sklepu z dostępną ścieżką i identyfikatorem produktu', async () => {
  const db = baza();
  db.prepare('INSERT INTO kanaly_kategorie VALUES (?, ?, ?, NULL, ?)').run(
    'polcien',
    '4',
    JSON.stringify(['Oświetlenie', 'Lampy wiszące']),
    AT,
  );
  await odczyt(db);
  expect(
    db
      .prepare('SELECT typ_kanalu, polaczenie, produkt_id, kategoria_id, kategoria_sciezka_json FROM karty_dane_kanalu')
      .get(),
  ).toEqual({
    typ_kanalu: 'sklep',
    polaczenie: 'polcien',
    produkt_id: '80',
    kategoria_id: '4',
    kategoria_sciezka_json: JSON.stringify(['Oświetlenie', 'Lampy wiszące']),
  });
});

it('pola bez źródła i zastana galeria są chronione, stary opis zachowuje dotychczasową postać', async () => {
  const db = baza();
  db.prepare("UPDATE karty_produktow SET ean = 'zastany', stawka_vat = '8'").run();
  db.prepare(
    `INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, adres_zrodlowy, utworzono_at)
    VALUES (1, 0, 'zastane', 'https://polcien.example.invalid/zastane.jpg', ?)`,
  ).run(AT);
  await odczyt(db, produkt({ description: '', tax_class: 'standard', manage_stock: true, stock_quantity: 200 }));
  expect(karta(db)).toMatchObject({ ean: 'zastany', stawka_vat: '8', opis: null });
  expect(karta(db).opis_sekcje_json).toContain('Krótki opis lampy');
  expect(db.prepare('SELECT adres_zrodlowy FROM zdjecia_kart').all()).toEqual([
    { adres_zrodlowy: 'https://polcien.example.invalid/zastane.jpg' },
  ]);
  expect(db.prepare("SELECT * FROM karty_zrodla_pol WHERE pole IN ('ean', 'zdjecia', 'stawka_vat')").all()).toEqual([]);
});

it('błąd zapisu treści cofa też lustro i źródła w jednej transakcji', async () => {
  const db = baza();
  db.exec(`CREATE TRIGGER odmowa_zdjec BEFORE INSERT ON zdjecia_kart BEGIN SELECT RAISE(ABORT, 'odmowa testowa'); END`);
  const wynik = await odswiezMagazyn({
    db,
    sklepy: {
      polcien: {
        pobierzWszystkieProdukty: async () => [produkt()],
        ustawienieSklepu: async () => 'yes',
      },
    },
    kanalySklepow: ['polcien'],
    kanalyAllegro: [],
    teraz: () => AT,
    log: () => {},
  });
  expect(wynik.kanaly[0].blad).toContain('odmowa testowa');
  expect(karta(db).opis_sekcje_json).toBeNull();
  expect(db.prepare('SELECT * FROM karty_zrodla_pol').all()).toEqual([]);
  expect(db.prepare('SELECT nazwa FROM produkty_sklepowe').get().nazwa).toBe('Lampa');
});
