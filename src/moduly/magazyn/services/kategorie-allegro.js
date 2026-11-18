// Opis kategorii Allegro z pamięci podręcznej `kanaly_kategorie` (migracja 0012).
//
// Oferta niesie tylko `category.id`; ścieżkę i opisy parametrów (typ, jednostka, `describesProduct`) doczytujemy
// RAZ na kategorię i połączenie, potem już tylko z bazy. Słowniki ponad PROG_SLOWNIKA wartości przycina
// `opisKategorii`, zanim wiersz powstanie (słownik marek to 95–99% z ok. 1 MB odpowiedzi).
//
// Odmowa z braku zakresu (401/403) NIE wywraca przebiegu: kategoria nieczytelna → null, parametry nieczytelne →
// sama ścieżka. W obu przypadkach nic nie zapisujemy — po nadaniu zakresu kolejny odczyt weźmie pełny opis.
// Inne błędy (5xx, sieć, limit czasu) lecą dalej: o ponowieniu decyduje przebieg.
//
// Opis w wersji 2 (wymagalność parametrów, liść, tworzenie produktu). W `parametry_json` leży
// obiekt `{wersja, lisc, tworzenieProduktu, parametry}`; wiersz w starym zapisie (sama tablica) albo starszy niż
// 30 dni jest pobierany ponownie przy następnym użyciu — bez migracji. Gdy odświeżenie się nie uda (odmowa, 5xx),
// zostaje stary wiersz: pamięć podręczna nie może zepsuć importu, który do dziś z niej korzystał.
import { opisKategorii, WERSJA_OPISU_KATEGORII } from '../../../domena/tresc-oferty-allegro.js';

// Drzewo kategorii Allegro ma kilka poziomów; granica chroni przed pętlą rodziców w odpowiedzi.
const MAKS_POZIOMOW = 10;
/** Po tylu dniach opis kategorii jest pobierany ponownie (Allegro zmienia parametry kategorii bez zapowiedzi). */
export const WAZNOSC_OPISU_DNI = 30;
const WAZNOSC_OPISU_MS = WAZNOSC_OPISU_DNI * 86_400_000;
/** Najwięcej trafień wyszukiwarki słownika. */
export const LIMIT_TRAFIEN_SLOWNIKA = 20;
/** Zgoda, bez której konto nie czyta opisu kategorii dla mapy. */
export const ZGODA_ODCZYTU = 'allegro:api:sale:offers:read';
const odmowa = (e) => e?.status === 401 || e?.status === 403;

function opisZWiersza(wiersz) {
  const sciezka = JSON.parse(wiersz.sciezka_json);
  const zapis = JSON.parse(wiersz.parametry_json ?? '[]');
  if (Array.isArray(zapis)) return { wersja: 1, lisc: null, tworzenieProduktu: null, sciezka, parametry: zapis };
  return {
    wersja: zapis?.wersja ?? 1,
    lisc: zapis?.lisc ?? null,
    tworzenieProduktu: zapis?.tworzenieProduktu ?? null,
    sciezka,
    parametry: Array.isArray(zapis?.parametry) ? zapis.parametry : [],
  };
}

function aktualny(opis, pobranoAt, teraz) {
  const wiek = teraz().getTime() - Date.parse(pobranoAt);
  return opis.wersja === WERSJA_OPISU_KATEGORII && Number.isFinite(wiek) && wiek <= WAZNOSC_OPISU_MS;
}

/**
 * @param {{ db: any, klient: { pobierzKategorie: Function, pobierzParametryKategorii: Function },
 *   polaczenie: string, kategoriaId: string | number | null | undefined, teraz?: () => Date }} opcje
 * @returns {Promise<{ wersja: number, lisc: boolean|null, tworzenieProduktu: boolean|null,
 *   sciezka: Array<{id: string, nazwa: string|null}>, parametry: any[] } | null>}
 */
export async function opisKategoriiAllegro({ db, klient, polaczenie, kategoriaId, teraz = () => new Date() }) {
  if (kategoriaId === null || kategoriaId === undefined || !String(kategoriaId).trim()) return null;
  const id = String(kategoriaId);

  const wiersz = db
    .prepare(
      'SELECT sciezka_json, parametry_json, pobrano_at FROM kanaly_kategorie WHERE polaczenie = ? AND kategoria_id = ?',
    )
    .get(polaczenie, id);
  const stary = wiersz ? opisZWiersza(wiersz) : null;
  if (stary && aktualny(stary, wiersz.pobrano_at, teraz)) return stary;

  const sciezka = [];
  const widziane = new Set();
  try {
    for (let biezaca = id; biezaca && !widziane.has(biezaca) && widziane.size < MAKS_POZIOMOW;) {
      widziane.add(biezaca);
      const kategoria = await klient.pobierzKategorie(biezaca);
      sciezka.unshift(kategoria);
      const rodzic = kategoria?.parent?.id;
      biezaca = rodzic === null || rodzic === undefined ? null : String(rodzic);
    }
  } catch (e) {
    if (stary) return stary;
    if (odmowa(e)) return null;
    throw e;
  }

  let parametry;
  try {
    parametry = await klient.pobierzParametryKategorii(id);
  } catch (e) {
    if (stary) return stary;
    if (odmowa(e)) return opisKategorii(sciezka, null);
    throw e;
  }

  const opis = opisKategorii(sciezka, parametry);
  const zapis = {
    wersja: opis.wersja,
    lisc: opis.lisc,
    tworzenieProduktu: opis.tworzenieProduktu,
    parametry: opis.parametry,
  };
  db.prepare(
    `INSERT INTO kanaly_kategorie (polaczenie, kategoria_id, sciezka_json, parametry_json, pobrano_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (polaczenie, kategoria_id) DO UPDATE SET sciezka_json = excluded.sciezka_json,
      parametry_json = excluded.parametry_json, pobrano_at = excluded.pobrano_at`,
  ).run(polaczenie, id, JSON.stringify(opis.sciezka), JSON.stringify(zapis), teraz().toISOString());
  return opis;
}

/**
 * Konto, przez które czytamy opis kategorii i podpowiedzi dla środowiska (pamięć `kanaly_kategorie` ma klucz
 * konta, a mapa jest na środowisko). Pierwsze w kolejności kluczy połączone konto tego środowiska ze zgodą
 * na odczyt ofert; brak → null (ekran mówi „połącz konto Allegro w środowisku X”).
 * @param {Array<{klucz: string, srodowisko: string, autoryzacja: string, uprawnienia?: string[]}>|null|undefined} konta
 * @param {'produkcja'|'sandbox'} srodowisko
 */
export function kontoOpisuSrodowiska(konta, srodowisko) {
  const pasujace = (Array.isArray(konta) ? konta : []).filter(
    (k) =>
      k?.srodowisko === srodowisko &&
      k.autoryzacja === 'polaczone' &&
      Array.isArray(k.uprawnienia) &&
      k.uprawnienia.includes(ZGODA_ODCZYTU),
  );
  pasujace.sort((a, b) => (a.klucz < b.klucz ? -1 : a.klucz > b.klucz ? 1 : 0));
  return pasujace[0] ?? null;
}

const doPorownania = (v) =>
  String(v ?? '')
    .trim()
    .toLocaleLowerCase('pl');

/**
 * Wyszukanie w słowniku parametru (np. marek, kilkanaście tysięcy wartości) na żądanie. Pobiera opis parametrów
 * kategorii z Allegro, NICZEGO nie zapisuje (słownik nie trafia do bazy) i oddaje najwyżej
 * LIMIT_TRAFIEN_SLOWNIKA wartości zawierających tekst (bez wielkości liter i spacji brzegowych), w kolejności słownika.
 * Błędy klienta lecą dalej — o komunikacie decyduje ekran.
 * @returns {Promise<Array<{id: string, wartosc: string}>>}
 */
export async function szukajWartosciSlownika({ klient, kategoriaId, parametrId, tekst }) {
  const szukane = doPorownania(tekst);
  if (!szukane) return [];
  const odpowiedz = await klient.pobierzParametryKategorii(String(kategoriaId));
  const parametr = (Array.isArray(odpowiedz?.parameters) ? odpowiedz.parameters : []).find(
    (p) => String(p?.id) === String(parametrId),
  );
  const slownik = Array.isArray(parametr?.dictionary) ? parametr.dictionary : [];
  const trafienia = [];
  for (const w of slownik) {
    if (trafienia.length >= LIMIT_TRAFIEN_SLOWNIKA) break;
    if (
      typeof w?.value === 'string' &&
      w.id !== undefined &&
      w.id !== null &&
      doPorownania(w.value).includes(szukane)
    ) {
      trafienia.push({ id: String(w.id), wartosc: w.value });
    }
  }
  return trafienia;
}
