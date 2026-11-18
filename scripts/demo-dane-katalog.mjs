// Katalog sklepu demo „Pracownia Półcień” w kształcie odpowiedzi API (Woo REST, Allegro /sale/offers).
// Jedno źródło dla dwóch odbiorców:
//   • generator (scripts/demo-dane.mjs) — puszcza go przez PRAWDZIWE odswiezMagazyn, więc lustro magazynu
//     w bazie demo powstaje tą samą drogą co u klienta po kliknięciu „Synchronizuj”;
//   • atrapy piaskownicy (deploy/proba/atrapy) — oddają ten sam katalog, więc synchronizacja w piaskownicy
//     niczego nie rozjeżdża („zniknęło 40 produktów” po pierwszym kliknięciu).
// Dane z PRODUKTY w demo-dane-firma.mjs; warianty to pary, które w katalogu są już osobnymi SKU (zamówienia
// demo nadal trafiają w te same SKU). Adresy w domenie .invalid — żaden link nie prowadzi do prawdziwego sklepu.
import { KANALY, PRODUKTY } from './demo-dane-firma.mjs';
import { wstawOferte, zmienOferte } from '../src/oms/db/oferty-kanalow.ts';

const ADRES_SKLEPU = 'https://sklep-polcien.example.invalid';
const YOAST_KATEGORIA = '_yoast_wpseo_primary_product_cat';

// Produkt wariantowy Woo = rodzic + warianty o SKU z katalogu. Atrybut „Rozmiar” magazyn czyta jako rozmiar.
const WARIANTY = [
  {
    nazwa: 'Lampa wisząca Kopuła, stal malowana',
    atrybut: 'Rozmiar',
    opcje: { 'LMP-WIS-001': '40 cm', 'LMP-WIS-002': '60 cm' },
  },
  {
    nazwa: 'Klosz szklany do lamp wiszących',
    atrybut: 'Szkło',
    opcje: { 'LMP-ABA-003': 'mleczne, 20 cm', 'LMP-ABA-004': 'dymne, 25 cm' },
  },
  {
    nazwa: 'Żarówka LED E27',
    atrybut: 'Rodzaj',
    opcje: { 'LMP-AKC-001': 'filament 2700 K', 'LMP-AKC-002': 'globe dymna 2200 K' },
  },
];

const kategorie = [...new Set(PRODUKTY.map((p) => p.kategoria))].map((nazwa, i) => ({
  id: 31 + i,
  name: nazwa,
  slug: slug(nazwa),
}));
const kategoria = (nazwa) => kategorie.find((k) => k.name === nazwa);

function slug(tekst) {
  return tekst
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
const cena = (gr) => (gr / 100).toFixed(2);

// Zdjęcia produktów: pliki w src/public/demo-produkty (CC0, źródła w ZRODLA.md), serwowane przez sam panel
// pod /public/ (bez logowania). ⚠️ Adres BEZWZGLĘDNY, i to w domenie demo publicznego: ekrany przepuszczają tylko http(s)
// (domena/miniatura-pozycji.js) — `data:` i ścieżka względna dają pustą miniaturę. Piaskownica i laptop pobierają je
// więc z demo.twojoms.pl; gdy demo leży, miniatury w piaskownicy znikają, a reszta działa.
export const ADRES_ZDJEC_DEMO = 'https://demo.twojoms.pl/public/demo-produkty';
// Kilka zdjęć na kategorię, przydzielanych po kolei produktom kategorii — powtarzają się, ale sąsiedzi się różnią.
const ZDJECIA = {
  'Lampy stołowe': ['stolowa-grzyb', 'stolowa-abazur'],
  'Lampy wiszące': ['wiszaca-emalia', 'wiszaca-kule'],
  'Lampy podłogowe': ['podlogowa-czasza'],
  Kinkiety: ['kinkiet-ramie'],
  'Lampki nocne': ['nocna-kula', 'nocna-sypialnia'],
  'Abażury i klosze': ['abazur-emalia'],
  Akcesoria: ['zarowka-filament'],
};

/** Adres zdjęcia produktu o danym SKU (deterministyczny) albo null dla SKU spoza katalogu. */
export function zdjecieProduktu(sku) {
  const p = PRODUKTY.find((x) => x.sku === sku);
  const pula = p && ZDJECIA[p.kategoria];
  if (!pula) return null;
  const nr = PRODUKTY.filter((x) => x.kategoria === p.kategoria).indexOf(p);
  return `${ADRES_ZDJEC_DEMO}/${pula[nr % pula.length]}.jpg`;
}

// Po dwa celowe braki zdjęć i opisu na kanał: Kinkiet Półksiężyc i Ramię
// w sklepie i na Allegro oraz dwie pierwsze karty outletu. Miniatury zamówień zostają, więc oferta
// Allegro z tej listy ma `primaryImage` przy pustym `images` celowo: treść oferty bez galerii.
const BEZ_TRESCI = new Set(['LMP-KIN-001', 'LMP-KIN-002', 'LMP-STO-002-OUT', 'LMP-STO-005-OUT']);
function zdjeciaKarty(sku) {
  if (BEZ_TRESCI.has(sku)) return [];
  const pierwsze = zdjecieProduktu(sku);
  if (!pierwsze) return [];
  const ile = (PRODUKTY.findIndex((p) => p.sku === sku) % 2) + 1;
  return [
    pierwsze,
    ...Array.from({ length: ile }, (_, i) => `${ADRES_ZDJEC_DEMO}/rys-${sku.toLowerCase()}-${i + 1}.png`),
  ];
}
function opisKarty(sku, nazwa) {
  if (BEZ_TRESCI.has(sku)) return { sections: [] };
  const p = PRODUKTY.find((p) => p.sku === sku);
  const zdjecia = zdjeciaKarty(sku);
  const w = WYMIARY_KATEGORII[p.kategoria];
  const szczegoly = BEZ_WYMIAROW.has(sku)
    ? '<p>Wymiary i wagę tego modelu uzupełnimy po pomiarze.</p>'
    : `<ul><li>Wymiary opakowania: ${w[0]} × ${w[1]} × ${w[2]} mm.</li><li>Waga opakowania: ${w[3]} g.</li></ul>`;
  return {
    sections: [
      {
        items: [
          { type: 'IMAGE', url: zdjecia[0] },
          {
            type: 'TEXT',
            content: `<h2>${nazwa}</h2><p><b>Model demonstracyjny</b> do spokojnego wnętrza. Krótka seria z pracowni.</p>`,
          },
        ],
      },
      {
        items: [
          {
            type: 'TEXT',
            content: `<h2>Wymiary i wykonanie</h2>${szczegoly}<p>Materiał i wykończenie: zgodnie z nazwą modelu. Rysunki pokazują przykładowe sylwetki lamp.</p>`,
          },
        ],
      },
      {
        items: [
          { type: 'IMAGE', url: zdjecia[1] },
          {
            type: 'TEXT',
            content: '<h2>Pielęgnacja</h2><p>Czyść miękką, suchą ściereczką. Przed czyszczeniem odłącz zasilanie.</p>',
          },
        ],
      },
    ],
  };
}

// Wymiary opakowania (szerokość × wysokość × głębokość w mm) i waga w gramach według kategorii, tak jak
// sklep podaje je w `dimensions`/`weight` (cm i kg). Kilka produktów celowo bez wymiarów — ekran braków w Magazynie
// ma co pokazać. Woo: length = wysokość, width = szerokość, height = głębokość (domena/rozmiar.js).
const WYMIARY_KATEGORII = {
  'Lampy stołowe': [300, 450, 300, 1800],
  'Lampy wiszące': [450, 400, 450, 2400],
  'Lampy podłogowe': [500, 1600, 500, 6500],
  Kinkiety: [250, 300, 180, 900],
  'Lampki nocne': [180, 250, 180, 700],
  'Abażury i klosze': [320, 280, 320, 600],
  Akcesoria: [120, 160, 80, 150],
};
const BEZ_WYMIAROW = new Set(['LMP-POD-003', 'LMP-KIN-004', 'LMP-AKC-003']);
const cm = (mm) => String(mm / 10);
function wymiaryWoo(sku, nazwaKategorii, przesuniecie) {
  const w = WYMIARY_KATEGORII[nazwaKategorii];
  if (!w || BEZ_WYMIAROW.has(sku)) return { dimensions: { length: '', width: '', height: '' }, weight: '' };
  const [szer, wys, gl, waga] = w;
  return {
    dimensions: {
      length: cm(wys + (przesuniecie % 3) * 30),
      width: cm(szer + (przesuniecie % 4) * 20),
      height: cm(gl),
    },
    weight: String((waga + (przesuniecie % 5) * 100) / 1000),
  };
}

function kanalyTypu(typ) {
  return KANALY.filter((k) => k.typ === typ).map((k) => k.klucz);
}

/** Surowe produkty Woo (`/wc/v3/products`) dla sklepu `kanal` i ich warianty (`/products/{id}/variations`). */
export function katalogWoo(kanal = kanalyTypu('woo')[0]) {
  const wSklepie = PRODUKTY.filter((p) => p.kanaly.includes(kanal));
  const produkty = [];
  const warianty = new Map();
  let id = 1100;
  const wspolne = (nazwa, nazwaKategorii, sku) => {
    const k = kategoria(nazwaKategorii);
    return {
      name: nazwa,
      status: 'publish',
      permalink: `${ADRES_SKLEPU}/produkt/${slug(nazwa)}/`,
      categories: [{ id: k.id, name: k.name, slug: k.slug }],
      images: zdjeciaKarty(sku).map((src, id) => ({ id, src })),
      description: opisKarty(sku, nazwa)
        .sections.flatMap((s) => s.items)
        .filter((e) => e.type === 'TEXT')
        .map((e) => e.content)
        .join(''),
      short_description: BEZ_TRESCI.has(sku) ? '' : `<p>${nazwa}. Wykonanie ręczne w pracowni (demo).</p>`,
      meta_data: [{ id: 1, key: YOAST_KATEGORIA, value: String(k.id) }],
    };
  };
  const zgrupowane = new Set(WARIANTY.flatMap((w) => Object.keys(w.opcje)));
  for (const p of wSklepie) {
    if (zgrupowane.has(p.sku)) continue;
    id += 1;
    produkty.push({
      id,
      type: 'simple',
      sku: p.sku,
      price: cena(p.cena_gr),
      regular_price: cena(p.cena_gr),
      manage_stock: id !== 1101,
      backorders: 'no',
      stock_status: 'instock',
      stock_quantity: id === 1101 ? null : 4 + (id % 9),
      attributes: [],
      ...wspolne(p.nazwa, p.kategoria, p.sku),
      ...wymiaryWoo(p.sku, p.kategoria, id),
    });
  }
  for (const w of WARIANTY) {
    const skusy = Object.keys(w.opcje).filter((sku) => wSklepie.some((p) => p.sku === sku));
    if (!skusy.length) continue;
    const pierwszy = PRODUKTY.find((p) => p.sku === skusy[0]);
    id += 1;
    const rodzicId = id;
    produkty.push({
      id: rodzicId,
      type: 'variable',
      sku: '',
      price: cena(Math.min(...skusy.map((s) => PRODUKTY.find((p) => p.sku === s).cena_gr))),
      regular_price: '',
      manage_stock: true,
      backorders: 'no',
      stock_status: 'instock',
      stock_quantity: 8,
      attributes: [{ id: 0, name: w.atrybut, variation: true, options: skusy.map((s) => w.opcje[s]) }],
      ...wspolne(w.nazwa, pierwszy.kategoria, pierwszy.sku),
    });
    warianty.set(
      String(rodzicId),
      skusy.map((sku, i) => {
        const p = PRODUKTY.find((x) => x.sku === sku);
        return {
          id: rodzicId * 10 + i + 1,
          sku,
          price: cena(p.cena_gr),
          regular_price: cena(p.cena_gr),
          status: 'publish',
          manage_stock: true,
          backorders: 'no',
          stock_status: 'instock',
          stock_quantity: 3 + i,
          permalink: `${ADRES_SKLEPU}/produkt/${slug(w.nazwa)}/?wariant=${i + 1}`,
          image: null,
          attributes: [{ id: 0, name: w.atrybut, option: w.opcje[sku] }],
          ...wymiaryWoo(sku, p.kategoria, i),
        };
      }),
    );
  }
  // Jeden wariant dziedziczy stan rodzica (przypadek syntetyczny, niepotwierdzony w P22).
  const wariantRodzica = warianty.values().next().value?.[0];
  if (wariantRodzica) Object.assign(wariantRodzica, { manage_stock: 'parent', stock_quantity: null });
  const miniatury = new Map(produkty.map((p) => [String(p.id), p.images[0]?.src ?? null]));
  return { produkty, warianty, miniatury, kategorie };
}

/** Surowe oferty Allegro (`/sale/offers`) konta `kanal`; primaryImage to zdjęcie demo (adres http). */
export function ofertyAllegro(kanal) {
  const nr = KANALY.findIndex((k) => k.klucz === kanal);
  return PRODUKTY.filter((p) => p.kanaly.includes(kanal)).map((p, i) => ({
    id: String(17000000000 + nr * 1000000 + i + 1),
    name: p.nazwa,
    external: { id: p.sku },
    sellingMode: { format: 'BUY_NOW', price: { amount: cena(p.cena_gr), currency: 'PLN' } },
    stock: { available: 2 + (i % 5), sold: i % 7 },
    publication: { status: 'ACTIVE' },
    category: { id: '257' },
    primaryImage: { url: zdjecieProduktu(p.sku) },
  }));
}

// Pełna oferta (`GET /sale/product-offers/{id}`), kategoria i jej parametry w kształcie z pomiaru P8.
// Drzewo demo: Dom i Ogród → Oświetlenie → Lampy (id jak `category.id` z ofertyAllegro). EAN-y z prefiksu 200
// (GS1 zostawia 200–299 do użytku wewnętrznego — żaden nie trafi w prawdziwy towar).
const KATEGORIE_ALLEGRO_DEMO = {
  5: { id: '5', name: 'Dom i Ogród', parent: null, leaf: false, options: { productCreationEnabled: false } },
  256: { id: '256', name: 'Oświetlenie', parent: { id: '5' }, leaf: false, options: { productCreationEnabled: false } },
  257: { id: '257', name: 'Lampy', parent: { id: '256' }, leaf: true, options: { productCreationEnabled: true } },
};
const parametrDemo = (id, name, type, describesProduct, dodatki = {}) => ({
  id,
  name,
  type,
  required: false,
  unit: null,
  requiredForProduct: false,
  options: { describesProduct, variantsAllowed: false, customValuesEnabled: false },
  restrictions: {},
  ...dodatki,
});
const PARAMETRY_LAMP = [
  parametrDemo('11323', 'Stan', 'dictionary', false, {
    required: true,
    dictionary: [
      { id: '11323_1', value: 'Nowy', dependsOnValueIds: [] },
      { id: '11323_2', value: 'Używany', dependsOnValueIds: [] },
    ],
  }),
  // Słownik marek ponad 200 wartości jak w prawdziwej kategorii — dwie pierwsze bez zmian.
  parametrDemo('248811', 'Marka', 'dictionary', true, {
    dictionary: [
      { id: '248811_9001', value: 'Pracownia Półcień', dependsOnValueIds: [] },
      { id: '248811_9002', value: 'bez marki', dependsOnValueIds: [] },
      ...Array.from({ length: 210 }, (_, i) => ({
        id: `248811_${9100 + i}`,
        value: `Marka przykładowa ${String(i + 1).padStart(3, '0')}`,
        dependsOnValueIds: [],
      })),
    ],
  }),
  parametrDemo('224017', 'Kod producenta', 'string', true, { restrictions: { minLength: 1, maxLength: 35 } }),
  parametrDemo('225693', 'EAN (GTIN)', 'string', true, { restrictions: { minLength: 8, maxLength: 14 } }),
  parametrDemo('17448', 'Waga produktu z opakowaniem jednostkowym', 'float', true, { unit: 'kg' }),
];

export function eanDemo(nr) {
  const cyfry = `200${String(nr).padStart(9, '0')}`;
  const suma = [...cyfry].reduce((s, c, i) => s + Number(c) * (i % 2 ? 3 : 1), 0);
  return cyfry + ((10 - (suma % 10)) % 10);
}

/** Kategoria Allegro (`GET /sale/categories/{id}`) albo null dla id spoza drzewa demo. */
export function kategoriaAllegroDemo(id) {
  const k = KATEGORIE_ALLEGRO_DEMO[String(id)];
  return k ? structuredClone(k) : null;
}

/** Parametry kategorii (`GET /sale/categories/{id}/parameters`) albo null dla id spoza drzewa demo. */
export function parametryKategoriiAllegroDemo(id) {
  return KATEGORIE_ALLEGRO_DEMO[String(id)] ? { parameters: structuredClone(PARAMETRY_LAMP) } : null;
}

const idProduktuDemo = (nr) => `00000000-0000-4000-8000-${String(nr).padStart(12, '0')}`;

// Dwie oferty wystawione „przez OMS” na koncie allegro dla kart tylko ze sklepu (stan aktywna
// i nieaktywna w demo). Poza `ofertyAllegro`, żeby lustro magazynu i liczby demo się nie zmieniły.
const OFERTY_E3_DEMO = {
  allegro: [
    ['LMP-KIN-004', '17900000001', 'ACTIVE'],
    ['LMP-NOC-003', '17900000002', 'INACTIVE'],
  ],
};

/** Oferty E3 demo konta `kanal` w kształcie `/sale/offers`. */
export function ofertyAllegroDemoE3(kanal) {
  return (OFERTY_E3_DEMO[kanal] ?? []).map(([sku, id, status]) => {
    const p = PRODUKTY.find((x) => x.sku === sku);
    return {
      id,
      name: p.nazwa,
      external: { id: sku },
      sellingMode: { format: 'BUY_NOW', price: { amount: cena(p.cena_gr), currency: 'PLN' } },
      stock: { available: status === 'ACTIVE' ? 2 : 0, sold: 0 },
      publication: { status },
      category: { id: '257' },
      primaryImage: { url: zdjecieProduktu(sku) },
    };
  });
}

/** Produkty katalogu Allegro po EAN (`/sale/products?mode=GTIN`): EAN karty demo = 1 produkt, prefiks 2009 = 2, reszta = 0. */
export function produktyAllegroDemoPoEan(ean) {
  const produkt = (id, name, e) => ({
    id,
    name,
    category: { id: '257' },
    parameters: [{ id: '225693', name: 'EAN (GTIN)', values: [e], valuesIds: null, rangeValue: null }],
  });
  if (String(ean).startsWith('2009'))
    return [1, 2].map((i) => produkt(`00000000-0000-4000-9000-00000000000${i}`, `Produkt wspólny ${i}`, String(ean)));
  const nr = PRODUKTY.findIndex((_, i) => eanDemo(i + 1) === String(ean)) + 1;
  return nr ? [produkt(idProduktuDemo(nr), PRODUKTY[nr - 1].nazwa, String(ean))] : [];
}

/** Pełna oferta konta `kanal` (`GET /sale/product-offers/{id}`) albo null, gdy konto nie ma takiej oferty. */
export function ofertaAllegroPelna(kanal, ofertaId) {
  const lista = [...ofertyAllegro(kanal), ...ofertyAllegroDemoE3(kanal)];
  const oferta = lista.find((o) => o.id === String(ofertaId));
  if (!oferta) return null;
  const p = PRODUKTY.find((x) => x.sku === oferta.external.id);
  const nr = PRODUKTY.indexOf(p) + 1;
  const waga =
    WYMIARY_KATEGORII[p.kategoria] && !BEZ_WYMIAROW.has(p.sku)
      ? String(WYMIARY_KATEGORII[p.kategoria][3] / 1000)
      : null;
  const wartosc = (id, name, values, valuesIds = null) => ({ id, name, values, valuesIds, rangeValue: null });
  return {
    id: oferta.id,
    name: oferta.name,
    productSet: [
      {
        quantity: { value: 1 },
        product: {
          id: idProduktuDemo(nr),
          publication: { status: 'LISTED' },
          parameters: [
            wartosc('248811', 'Marka', ['Pracownia Półcień'], ['248811_9001']),
            wartosc('224017', 'Kod producenta', [p.sku]),
            wartosc('225693', 'EAN (GTIN)', [eanDemo(nr)]),
            ...(waga ? [wartosc('17448', 'Waga produktu z opakowaniem jednostkowym', [waga])] : []),
          ],
          isAiCoCreated: true,
        },
        responsiblePerson: null,
        responsibleProducer: null,
        safetyInformation: null,
        marketedBeforeGPSRObligation: null,
      },
    ],
    parameters: [wartosc('11323', 'Stan', ['Nowy'], ['11323_1'])],
    aiCoCreatedContent: { images: [] },
    images: zdjeciaKarty(p.sku),
    stock: { available: oferta.stock.available, unit: 'UNIT' },
    publication: oferta.publication,
    category: oferta.category,
    taxSettings: { subject: 'GOODS', exemption: null, rates: [{ rate: '23.00', countryCode: 'PL' }] },
    sellingMode: { ...oferta.sellingMode, startingPrice: null, minimalPrice: null },
    external: oferta.external,
    description: opisKarty(p.sku, p.nazwa),
    language: 'pl-PL',
    createdAt: '2026-03-02T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
  };
}

/**
 * Klienci tylko-do-odczytu katalogu (metody i kształty jak w src/oms/woo/client.js i src/oms/allegro/client.js),
 * dla generatora. Atrapy piaskownicy rozszerzają ich o zapis i resztę metod.
 */
export function klienciKataloguDemo() {
  const sklepy = Object.fromEntries(
    kanalyTypu('woo').map((kanal) => {
      const k = katalogWoo(kanal);
      return [
        kanal,
        {
          pobierzWszystkieProdukty: async () => structuredClone(k.produkty),
          pobierzWarianty: async (id) => structuredClone(k.warianty.get(String(id)) ?? []),
          pobierzMiniatury: async () => new Map(k.miniatury),
          ustawienieSklepu: async (id) =>
            ({ woocommerce_dimension_unit: 'cm', woocommerce_weight_unit: 'kg' })[id] ?? '',
        },
      ];
    }),
  );
  const allegro = Object.fromEntries(
    kanalyTypu('allegro').map((kanal) => [
      kanal,
      {
        pobierzOferty: async () => ofertyAllegro(kanal),
      },
    ]),
  );
  return { sklepy, allegro, kanalySklepow: kanalyTypu('woo'), kanalyAllegro: kanalyTypu('allegro') };
}

/**
 * Stan „firma zaczęła wystawiać z OMS” w bazie demo: mapa kategorii Lampy wiszące → 257, dwie marki
 * dopasowane do słownika 248811 i cztery oferty OMS na koncie allegro dla kart tylko ze sklepu (szkic, problem,
 * aktywna, nieaktywna). Aktywna i nieaktywna mają id z `ofertyAllegroDemoE3`, więc atrapa oddaje je po `GET`.
 */
export function zasiejOfertyAllegroDemo(db, { teraz }) {
  const at = teraz();
  db.prepare(
    `INSERT INTO allegro_mapa_kategorii (kategoria_karty, srodowisko, kategoria_allegro_id, sciezka_json, potwierdzil, potwierdzono_at)
    VALUES ('Lampy wiszące', 'produkcja', '257', '["Dom i Ogród","Oświetlenie","Lampy"]', 'operator-demo', ?)`,
  ).run(at);
  const marka =
    db.prepare(`INSERT INTO allegro_marki (marka, srodowisko, parametr_id, wartosc_id, kategorie_sprawdzone_json, potwierdzil, zmieniono_at)
    VALUES (?, 'produkcja', '248811', ?, '["257"]', 'operator-demo', ?)`);
  marka.run('Pracownia Półcień', '248811_9001', at);
  marka.run('Marka przykładowa 001', '248811_9100', at);
  const karta = (sku) => db.prepare('SELECT id FROM karty_produktow WHERE sku = ?').get(sku)?.id;
  const [aktywna, nieaktywna] = ofertyAllegroDemoE3('allegro');
  const oferty = [
    ['LMP-WIS-005', 'ext:LMP-WIS-005', 'szkic', null],
    [
      'LMP-POD-004',
      'ext:LMP-POD-004',
      'problem',
      [
        {
          kod: 'brak-mapy-kategorii',
          tekst: 'Kategoria karty „Lampy podłogowe” nie ma kategorii Allegro — wskaż ją w ustawieniach ofert.',
        },
      ],
    ],
    [aktywna.external.id, aktywna.id, 'aktywna', null],
    [nieaktywna.external.id, nieaktywna.id, 'nieaktywna', null],
  ];
  for (const [sku, idZewnetrzne, stan, problemy] of oferty) {
    const kartaId = karta(sku);
    if (!kartaId) throw new Error(`DEMO_OFERTY: brak karty ${sku}`);
    const o = wstawOferte(db, { kartaId, kanal: 'allegro', idZewnetrzne, pochodzenie: 'oms', stan }, { teraz: at });
    if (problemy) zmienOferte(db, o.id, { problemy }, { teraz: at });
  }
}
