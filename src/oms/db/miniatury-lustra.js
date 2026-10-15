// Odczyt miniatur z LUSTRA sklepów (`produkty_sklepowe.miniatura`) dla pozycji, które są
// właśnie na ekranie. Jedna funkcja, JEDNO zapytanie — cała wartość tej poprawki pochodzi
// z bazy i NIE MA TU ANI JEDNEGO nowego żądania do sklepu.
//
// Dlaczego to w ogóle działa: kolumnę `miniatura` wypełnia odczyt katalogów ze Store API
// (services/magazyn-sync.js), a po odczycie z 2026-08-12 ma ją 1456 z 1459 wierszy lustra.
// Pozycja zamówienia zna kanał (`zamowienia.sklep`) i numer produktu (`pozycje.produkt_id`),
// więc para `(kanal, produkt_id)` wskazuje wiersz lustra wprost.
//
// Regułę „co zrobić z wynikiem" trzyma domena (domain/miniatura-pozycji.js) — ten plik
// odpowiada WYŁĄCZNIE na pytanie „co wie lustro".
import { kluczLustra } from '../../domena/miniatura-pozycji.js';

/**
 * Mapa `kluczLustra(kanal, produkt_id)` → adres miniatury, dla WSKAZANYCH par.
 *
 * ⚠️⚠️ JEDNO ZAPYTANIE NA EKRAN, NIE JEDNO NA WIERSZ. Lista zamówień renderuje kilkadziesiąt
 * zamówień po kilka pozycji: odczyt „per pozycja" znaczyłby setki `prepare` na KAŻDE otwarcie
 * strony głównej. To jest ta sama usterka, którą złapał już `idx_pozycje_zamowienie_id`
 * (pierwszy start po wdrożeniu: 33,5 s zamiast 2,3 s) — i tak samo jak tam, na bazie testowej
 * jest niewidoczna. Pilnuje jej test liczący WYKONANIA, nie milisekundy
 * (tests/oms/miniatury-lustro.test.js).
 *
 * ⚠️ WARUNEK JEST `kanal IN (…) AND produkt_id IN (…)`, czyli PROSTOKĄT SZERSZY niż zbiór par —
 * i dlatego wiersze są jeszcze odsiewane po stronie JS. Dwa powody, żeby tak, a nie listą
 * warunków `(kanal=? AND produkt_id=?) OR …`: parametrów jest tyle, ile RÓŻNYCH kanałów plus
 * różnych produktów (a nie dwa na pozycję), i oba `IN` sięgają po `idx_produkty_sklepowe_kanal`.
 * Cena: para, o którą nikt nie pytał, nie ma prawa wejść do mapy — bo trafiłaby w cudzy wiersz.
 *
 * ⚠️⚠️ CZŁON `kanal IN (…)` JEST ZAWĘŻENIEM KOSZTU, A NIE STRAŻNIKIEM POPRAWNOŚCI — i wie o tym
 * weryfikacja mutacyjna: jego usunięcie NIE WYWALA żadnego testu (sprawdzone 2026-08-12), bo
 * poprawności pilnuje odsiew `szukane.has(klucz)` niżej, budowany z kanału TEGO WIERSZA. To NIE
 * JEST martwy kod do „posprzątania": bez niego zapytanie ciągnęłoby numer produktu ze WSZYSTKICH
 * kanałów naraz i przestałoby korzystać z indeksu po kanale. Prawdziwy strażnik pary ma własny
 * test („róg prostokąta, o który nie pytano, nie wchodzi do mapy") i tamten mutację łapie —
 * dopiero po tym, jak pierwsza wersja tego testu okazała się celować w róg, którego w bazie
 * nie było.
 *
 * ⚠️ MAPA, NIE LITERAŁ OBIEKTU. Klucze budujemy z wartości pochodzących z cudzych API
 * (kanał i identyfikator produktu). Literał obiektu dziedziczy z `Object.prototype`, więc
 * klucz równy `constructor` albo `toString` oddałby FUNKCJĘ NATYWNĄ zamiast `undefined` —
 * a ona trafiłaby wprost do atrybutu `src` na karcie zamówienia.
 *
 * ⚠️ BEZ WARUNKU `zniknal_at IS NULL`, i to jest treść, nie przeoczenie. Produkt wycofany
 * ze sklepu ma nadal PRAWDZIWĄ miniaturę, a archiwum zamówień to największy zbiór ekranów,
 * na których ta poprawka cokolwiek zmienia. Odsianie zniknietych zabrałoby właśnie jego.
 *
 * ⚠️ Czego lustro nie wie, tego W MAPIE NIE MA — nigdy pustego napisu ani `null` jako wartości.
 * Wpis „wiem, że nie wiem" przeciąłby gałąź zapasową w domenie, czyli zgasiłby zdjęcia, które
 * dziś działają (PRO, Allegro, archiwum sprzed pierwszego odczytu katalogu).
 */
export function miniaturyLustra(db, pary) {
  const mapa = new Map();

  // Klucze, o które NAPRAWDĘ pytamy. Para bez kanału albo bez produktu (pozycja dopisana
  // ręcznie, wiersz „Razem", wiersz wysyłki) wypada tu, a nie w SQL-u: warunek zbudowany
  // z pustki złapałby wiersz o pustym `produkt_id`.
  const szukane = new Set();
  const kanaly = new Set();
  const produkty = new Set();
  for (const p of pary ?? []) {
    const klucz = kluczLustra(p?.kanal, p?.produktId);
    if (klucz === null) continue;
    szukane.add(klucz);
    kanaly.add(String(p.kanal));
    produkty.add(String(p.produktId));
  }
  // Ekran bez ani jednej pozycji sklepowej (same zamówienia ręczne) nie ma o co pytać —
  // i nie dotyka bazy ANI RAZU.
  if (szukane.size === 0) return mapa;

  const kanalyLista = [...kanaly];
  const produktyLista = [...produkty];
  const wiersze = db.prepare(
    'SELECT kanal, produkt_id, miniatura FROM produkty_sklepowe'
    + ` WHERE kanal IN (${kanalyLista.map(() => '?').join(',')})`
    + ` AND produkt_id IN (${produktyLista.map(() => '?').join(',')})`
    // Wiersz bez miniatury nie niesie odpowiedzi — odsiewamy go już w SQL-u, żeby nie
    // przesłonił wariantu tego samego produktu, który miniaturę MA (patrz niżej).
    + " AND miniatura IS NOT NULL AND TRIM(miniatura) <> ''"
    // ⚠️ KOLEJNOŚĆ MUSI BYĆ STAŁA. Produkt wariantowy ma w lustrze WIELE wierszy o tym samym
    // `produkt_id` (po jednym na wariant), a każdy niesie miniaturę RODZICA. Bez `ORDER BY`
    // ta sama pozycja pokazywałaby raz jedno, raz drugie zdjęcie — przy każdym odświeżeniu.
    + ' ORDER BY id ASC',
  ).all(...kanalyLista, ...produktyLista);

  for (const w of wiersze) {
    const klucz = kluczLustra(w.kanal, w.produkt_id);
    // Prostokąt z `IN` bywa szerszy niż zbiór par — patrz komentarz nad funkcją.
    if (klucz === null || !szukane.has(klucz) || mapa.has(klucz)) continue;
    mapa.set(klucz, w.miniatura);
  }
  return mapa;
}

/**
 * Pary `(kanal, produktId)` wyłuskane z ZAMÓWIEŃ — materiał wejściowy `miniaturyLustra`.
 *
 * ⚠️ KANAŁ BIERZE SIĘ Z `zamowienia.sklep`, a nie z pozycji: pozycja go nie zna, a to on
 * rozstrzyga, w KTÓRYM lustrze szukać. Wartości kolumny (`sklep_b`, `sklep_a`, `allegro_*`,
 * `reczne`) są TYMI SAMYMI, co `produkty_sklepowe.kanal` — poza `reczne`, którego w lustrze
 * nie ma i mieć nie będzie. Zamówienie ręczne po prostu nic tu nie wnosi i renderuje się
 * dokładnie tak, jak dziś.
 *
 * ⚠️ ALLEGRO WYPADA SAMO, i tak ma być: pozycja z Allegro trzyma numer OFERTY w osobnej
 * kolumnie `oferta_id`, a `produkt_id` ma puste. Jego miniatura powstaje po staremu, przez
 * podmianę segmentu `/original/` na `/s150/` — droga ZMIERZONA i działająca.
 */
export function paryPozycji(zamowienia) {
  const pary = [];
  for (const z of zamowienia ?? []) {
    for (const p of z?.pozycje ?? []) {
      if (kluczLustra(z?.sklep, p?.produkt_id) !== null) {
        pary.push({ kanal: z.sklep, produktId: p.produkt_id });
      }
    }
  }
  return pary;
}
