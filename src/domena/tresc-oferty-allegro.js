// Treść oferty Allegro → karta produktu. Reguła CZYSTA: bez sieci, bazy i zegara.
//
// Wejście: odpowiedź `GET /sale/product-offers/{id}`
// i opis kategorii z pamięci podręcznej (`opisKategorii`, trzymany w `kanaly_kategorie`). Oferta niesie tylko
// `category.id` i wartości parametrów — typ, jednostkę i `describesProduct` zna dopiero opis kategorii.
//
// Czego tu świadomie NIE ma:
//   • producenta, osoby odpowiedzialnej i informacji o bezpieczeństwie (to ustawienie konta, nie karty);
//   • rozstrzygania, czy pole wolno zapisać (`importMozeZapisac` w `zrodla-pol.js` — robi to zapis karty w `moduly/magazyn/services/allegro-tresc-kart.js`);
//   • walidacji EAN — zapisujemy to, co sprzedawca wpisał w parametrze EAN; ocena należy do ekranu karty.
import { sekcjeAllegroDoSekcji } from './opis-sekcje.js';
import { groszeZCeny } from './allegro-oferta.js';
import { STAWKI_VAT } from './vat.js';

/** Id parametru „EAN (GTIN)” — jedyne id parametru wpisane w kod (pole `options.isGTIN` w odpowiedzi nie występuje). */
export const PARAMETR_EAN = '225693';

/** Słownik dłuższy niż tyle wartości nie trafia do pamięci (słownik marek to 95–99% z ok. 1 MB odpowiedzi). */
export const PROG_SLOWNIKA = 200;

const napis = (v) => (typeof v === 'string' && v.trim() ? v : null);
const id = (v) => ((typeof v === 'string' || typeof v === 'number') && String(v).trim() ? String(v) : null);

/** Wersja kształtu opisu kategorii. Wiersz pamięci w innej wersji jest pobierany ponownie. */
export const WERSJA_OPISU_KATEGORII = 2;

// Warunki i ograniczenia Allegro przechodzą bez zmian, ale jako kopia — opis nie dzieli referencji
// z odpowiedzią. Wartości to czysty JSON, więc structuredClone wystarcza.
const kopiaObiektu = (v) => (v && typeof v === 'object' ? structuredClone(v) : null);

/**
 * Opis kategorii do pamięci podręcznej (wersja 2): ścieżka (od korzenia do liścia), czy kategoria
 * jest liściem i pozwala tworzyć produkt (`options.productCreationEnabled` liścia) oraz opisy parametrów
 * z wymagalnością (`required`, `requiredForProduct`, `requiredIf`), widocznością i ograniczeniami.
 * `lisc` i `tworzenieProduktu` = null, gdy ścieżki nie ma (nie wiadomo).
 * @param sciezka obiekty `GET /sale/categories/{id}` od korzenia do liścia
 * @param odpowiedzParametrow odpowiedź `GET /sale/categories/{id}/parameters`
 */
export function opisKategorii(sciezka, odpowiedzParametrow) {
  const kategorie = (Array.isArray(sciezka) ? sciezka : []).filter((k) => id(k?.id));
  const ostatnia = kategorie.at(-1);
  return {
    wersja: WERSJA_OPISU_KATEGORII,
    lisc: ostatnia ? ostatnia.leaf === true : null,
    tworzenieProduktu: ostatnia ? ostatnia.options?.productCreationEnabled === true : null,
    sciezka: kategorie.map((k) => ({ id: String(k.id), nazwa: napis(k.name) })),
    parametry: (Array.isArray(odpowiedzParametrow?.parameters) ? odpowiedzParametrow.parameters : [])
      .filter((p) => id(p?.id))
      .map(opisParametru),
  };
}

function wartoscSlownika(w) {
  const wartosc = { id: id(w?.id), wartosc: napis(w?.value) };
  const nadrzedne = Array.isArray(w?.dependsOnValueIds) ? w.dependsOnValueIds.map(id).filter(Boolean) : [];
  return nadrzedne.length ? { ...wartosc, zalezyOdWartosci: nadrzedne } : wartosc;
}

function opisParametru(p) {
  const wartosci = Array.isArray(p.dictionary) ? p.dictionary : [];
  const opis = {
    id: String(p.id),
    nazwa: napis(p.name),
    typ: napis(p.type),
    jednostka: napis(p.unit),
    opisujeProdukt: p.options?.describesProduct === true,
    slownik: null,
    liczbaWartosci: wartosci.length,
    wymagany: p.required === true,
    wymaganyDlaProduktu: p.requiredForProduct === true,
    wymaganyGdy: kopiaObiektu(p.requiredIf),
    widocznyGdy: kopiaObiektu(p.displayedIf),
    ograniczenia: kopiaObiektu(p.restrictions),
    zalezyOd: id(p.options?.dependsOnParameterId),
  };
  if (wartosci.length > PROG_SLOWNIKA) return { ...opis, slownikWyciety: true };
  if (Array.isArray(p.dictionary)) opis.slownik = wartosci.map(wartoscSlownika);
  return opis;
}

/**
 * @param oferta odpowiedź `GET /sale/product-offers/{id}` (może być pusta — wtedy puste pola, bez wyjątku)
 * @param kategoria wynik `opisKategorii` dla `oferta.category.id` albo null, gdy opisu nie ma (np. brak zakresu)
 * @throws gdy cena jest w walucie innej niż PLN albo w zapisie, którego nie umiemy przeliczyć — ta sama reguła
 *   co w lustrze magazynu (`groszeZCeny`), bo cena ląduje w tej samej kolumnie `cena_gr`.
 */
export function trescOfertyAllegro(oferta, kategoria) {
  const produkt = Array.isArray(oferta?.productSet) ? oferta.productSet[0]?.product : null;
  const parametryProduktu = Array.isArray(produkt?.parameters) ? produkt.parameters : [];
  const parametryOferty = Array.isArray(oferta?.parameters) ? oferta.parameters : [];
  const ofertaId = id(oferta?.id);

  const opisy = new Map((kategoria?.parametry ?? []).map((p) => [p.id, p]));
  const podzial = { produkt: [], oferta: [] };
  const widziane = new Set();
  for (const [miejsce, lista] of [
    ['produkt', parametryProduktu],
    ['oferta', parametryOferty],
  ]) {
    for (const p of lista) {
      const pid = id(p?.id);
      if (!pid || widziane.has(pid)) continue;
      widziane.add(pid);
      const opis = opisy.get(pid);
      // Kategoria rozstrzyga (`describesProduct`); bez jej opisu zostaje miejsce w odpowiedzi.
      const gdzie = opis ? (opis.opisujeProdukt ? 'produkt' : 'oferta') : miejsce;
      podzial[gdzie].push({
        id: pid,
        nazwa: napis(p.name),
        wartosci: Array.isArray(p.values) ? [...p.values] : [],
        wartosciId: Array.isArray(p.valuesIds) ? [...p.valuesIds] : null,
        zakres: p.rangeValue ?? null,
        typ: opis?.typ ?? null,
        jednostka: opis?.jednostka ?? null,
      });
    }
  }

  const ean = parametryProduktu.find((p) => id(p?.id) === PARAMETR_EAN)?.values?.[0];
  // product.isAiCoCreated to flaga Katalogu Allegro, nie deklaracja sprzedawcy.
  const ai = Array.isArray(oferta?.aiCoCreatedContent?.images) && oferta.aiCoCreatedContent.images.length > 0;
  return {
    pola: {
      nazwa: napis(oferta?.name),
      ean: typeof ean === 'string' && ean.trim() ? ean.trim() : null,
      cena_gr: groszeZCeny(oferta?.sellingMode?.price, ofertaId ?? '(bez id)'),
      stawka_vat: stawkaVat(oferta?.taxSettings),
    },
    opisSekcje: sekcjeAllegroDoSekcji(oferta?.description),
    zdjeciaAi: (Array.isArray(oferta?.aiCoCreatedContent?.images) ? oferta.aiCoCreatedContent.images : [])
      .map((z) => (typeof z === 'string' ? z : z?.url))
      .filter((z) => typeof z === 'string' && z.trim()),
    zdjecia: (Array.isArray(oferta?.images) ? oferta.images : [])
      .map((z) => (typeof z === 'string' ? z : z?.url))
      .filter((z) => typeof z === 'string' && z.trim()),
    daneKanalu: {
      kategoria_id: id(oferta?.category?.id),
      sciezka: kategoria?.sciezka ?? [],
      parametry: podzial,
      ai_wspoltworzone: ai ? 1 : 0,
      updatedAt: napis(oferta?.updatedAt),
      oferta_id: ofertaId,
      produkt_id: id(produkt?.id),
    },
  };
}

// Stawka polska z `taxSettings.rates` ('23.00' → '23'). Brak ustawień, zwolnienie albo stawka spoza listy OMS → null.
function stawkaVat(taxSettings) {
  // Zwolnienie (`exemption`) to nie stawka 0% — pole zostaje puste do ręcznego ustawienia.
  if (typeof taxSettings?.exemption === 'string' && taxSettings.exemption.trim()) return null;
  const rates = Array.isArray(taxSettings?.rates) ? taxSettings.rates : [];
  const pl = rates.find((r) => r?.countryCode === 'PL')?.rate;
  const m = typeof pl === 'string' ? /^(\d+)(?:\.0+)?$/.exec(pl.trim()) : null;
  const stawka = m ? String(Number(m[1])) : null;
  return stawka !== null && STAWKI_VAT.includes(stawka) ? stawka : null;
}
