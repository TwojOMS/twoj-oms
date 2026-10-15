// PRZ-076 — katalog sklepu demo „Pracownia Półcień” w kształcie odpowiedzi API (Woo REST, Allegro /sale/offers).
// Jedno źródło dla dwóch odbiorców:
//   • generator (scripts/demo-dane.mjs) — puszcza go przez PRAWDZIWE odswiezMagazyn, więc lustro magazynu
//     w bazie demo powstaje tą samą drogą co u klienta po kliknięciu „Synchronizuj”;
//   • atrapy piaskownicy (deploy/proba/atrapy) — oddają ten sam katalog, więc synchronizacja w piaskownicy
//     niczego nie rozjeżdża („zniknęło 40 produktów” po pierwszym kliknięciu).
// Dane z PRODUKTY w demo-dane-firma.mjs; warianty to pary, które w katalogu są już osobnymi SKU (zamówienia
// demo nadal trafiają w te same SKU). Adresy w domenie .invalid — żaden link nie prowadzi do prawdziwego sklepu.
import { KANALY, PRODUKTY } from './demo-dane-firma.mjs';

const ADRES_SKLEPU = 'https://sklep-polcien.example.invalid';
const YOAST_KATEGORIA = '_yoast_wpseo_primary_product_cat';

// Produkt wariantowy Woo = rodzic + warianty o SKU z katalogu. Atrybut „Rozmiar” magazyn czyta jako rozmiar.
const WARIANTY = [
  { nazwa: 'Lampa wisząca Kopuła, stal malowana', atrybut: 'Rozmiar', opcje: { 'LMP-WIS-001': '40 cm', 'LMP-WIS-002': '60 cm' } },
  { nazwa: 'Klosz szklany do lamp wiszących', atrybut: 'Szkło', opcje: { 'LMP-ABA-003': 'mleczne, 20 cm', 'LMP-ABA-004': 'dymne, 25 cm' } },
  { nazwa: 'Żarówka LED E27', atrybut: 'Rodzaj', opcje: { 'LMP-AKC-001': 'filament 2700 K', 'LMP-AKC-002': 'globe dymna 2200 K' } },
];

const KOLORY = { 'Lampy stołowe': '#B7791F', 'Lampy wiszące': '#2F6F5E', 'Lampy podłogowe': '#6B4F3A', Kinkiety: '#5A5F8C',
  'Lampki nocne': '#8C5A7A', 'Abażury i klosze': '#7A8C5A', Akcesoria: '#5F6B73' };

const kategorie = [...new Set(PRODUKTY.map((p) => p.kategoria))].map((nazwa, i) => ({ id: 31 + i, name: nazwa, slug: slug(nazwa) }));
const kategoria = (nazwa) => kategorie.find((k) => k.name === nazwa);

function slug(tekst) {
  return tekst.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
const cena = (gr) => (gr / 100).toFixed(2);

/** Zaślepka zdjęcia: SVG w data: (bez sieci, bez pliku) — kolor kategorii i inicjał nazwy. */
export function zaslepkaZdjecia(nazwa, nazwaKategorii) {
  const kolor = KOLORY[nazwaKategorii] ?? '#5F6B73';
  const litera = nazwa.trim().split(/\s+/).at(-1)?.[0]?.toUpperCase() ?? '?';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="76" height="76" viewBox="0 0 76 76">`
    + `<rect width="76" height="76" rx="10" fill="${kolor}"/>`
    + `<path d="M26 22h24l6 18H20z" fill="#fff" fill-opacity=".85"/><rect x="36" y="40" width="4" height="16" fill="#fff" fill-opacity=".85"/>`
    + `<text x="38" y="70" font-family="sans-serif" font-size="9" fill="#fff" text-anchor="middle">${litera}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function kanalyTypu(typ) { return KANALY.filter((k) => k.typ === typ).map((k) => k.klucz); }

/** Surowe produkty Woo (`/wc/v3/products`) dla sklepu `kanal` i ich warianty (`/products/{id}/variations`). */
export function katalogWoo(kanal = kanalyTypu('woo')[0]) {
  const wSklepie = PRODUKTY.filter((p) => p.kanaly.includes(kanal));
  const produkty = [];
  const warianty = new Map();
  let id = 1100;
  const wspolne = (nazwa, nazwaKategorii) => {
    const k = kategoria(nazwaKategorii);
    return { name: nazwa, status: 'publish', permalink: `${ADRES_SKLEPU}/produkt/${slug(nazwa)}/`,
      categories: [{ id: k.id, name: k.name, slug: k.slug }], images: [],
      short_description: `<p>${nazwa}. Wykonanie ręczne w pracowni (demo).</p>`,
      meta_data: [{ id: 1, key: YOAST_KATEGORIA, value: String(k.id) }] };
  };
  const zgrupowane = new Set(WARIANTY.flatMap((w) => Object.keys(w.opcje)));
  for (const p of wSklepie) {
    if (zgrupowane.has(p.sku)) continue;
    id += 1;
    produkty.push({ id, type: 'simple', sku: p.sku, price: cena(p.cena_gr), regular_price: cena(p.cena_gr),
      stock_status: 'instock', stock_quantity: 4 + (id % 9), attributes: [], ...wspolne(p.nazwa, p.kategoria) });
  }
  for (const w of WARIANTY) {
    const skusy = Object.keys(w.opcje).filter((sku) => wSklepie.some((p) => p.sku === sku));
    if (!skusy.length) continue;
    const pierwszy = PRODUKTY.find((p) => p.sku === skusy[0]);
    id += 1;
    const rodzicId = id;
    produkty.push({ id: rodzicId, type: 'variable', sku: '', price: cena(Math.min(...skusy.map((s) => PRODUKTY.find((p) => p.sku === s).cena_gr))),
      regular_price: '', stock_status: 'instock', stock_quantity: null,
      attributes: [{ id: 0, name: w.atrybut, variation: true, options: skusy.map((s) => w.opcje[s]) }], ...wspolne(w.nazwa, pierwszy.kategoria) });
    warianty.set(String(rodzicId), skusy.map((sku, i) => {
      const p = PRODUKTY.find((x) => x.sku === sku);
      return { id: rodzicId * 10 + i + 1, sku, price: cena(p.cena_gr), regular_price: cena(p.cena_gr), status: 'publish',
        stock_status: 'instock', stock_quantity: 3 + i, permalink: `${ADRES_SKLEPU}/produkt/${slug(w.nazwa)}/?wariant=${i + 1}`,
        image: null, attributes: [{ id: 0, name: w.atrybut, option: w.opcje[sku] }] };
    }));
  }
  const miniatury = new Map(produkty.map((p) => [String(p.id), zaslepkaZdjecia(p.name, p.categories[0].name)]));
  return { produkty, warianty, miniatury, kategorie };
}

/** Surowe oferty Allegro (`/sale/offers`) konta `kanal`. Bez primaryImage: miniatura Allegro musi być adresem http. */
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
    primaryImage: null,
  }));
}

/**
 * Klienci tylko-do-odczytu katalogu (metody i kształty jak w src/oms/woo/client.js i src/oms/allegro/client.js),
 * dla generatora. Atrapy piaskownicy rozszerzają ich o zapis i resztę metod.
 */
export function klienciKataloguDemo() {
  const sklepy = Object.fromEntries(kanalyTypu('woo').map((kanal) => {
    const k = katalogWoo(kanal);
    return [kanal, {
      pobierzWszystkieProdukty: async () => structuredClone(k.produkty),
      pobierzWarianty: async (id) => structuredClone(k.warianty.get(String(id)) ?? []),
      pobierzMiniatury: async () => new Map(k.miniatury),
    }];
  }));
  const allegro = Object.fromEntries(kanalyTypu('allegro').map((kanal) => [kanal, {
    pobierzOferty: async () => ofertyAllegro(kanal),
  }]));
  return { sklepy, allegro, kanalySklepow: kanalyTypu('woo'), kanalyAllegro: kanalyTypu('allegro') };
}
