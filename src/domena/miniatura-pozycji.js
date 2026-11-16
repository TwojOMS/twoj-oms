// Miniatura POZYCJI ZAMÓWIENIA — jedna reguła dla wszystkich ekranów, które ją pokazują.
//
// ⚠️⚠️ PO CO TEN PLIK ISTNIEJE. Samo `adresMiniatury` (domena/miniatury.js) liczy adres
// miniatury ZGADYWANIEM, czyli DOKLEJA `-150x150` do nazwy pliku oryginału. Zmierzone na
// prawdziwych sklepach: w jednym zgadywanie trafiało w każdy adres, w drugim dawało 404
// na zdecydowanej większości (blisko 9 na 10).
//
// Powód: sklep może skalować miniatury do własnego rozmiaru, a nie do WordPressowego `150x150`.
// Tam, gdzie zgadywanie trafia, trafia PRZYPADKIEM. Prawdziwy adres leży w kolumnie
// `produkty_sklepowe.miniatura` — bierze się wprost ze Store API sklepu
// (moduly/magazyn/services/magazyn-sync.js),
// więc panel nie musi o niego pytać sklepu ANI RAZU: pozycja zna kanał (`zamowienia.sklep`)
// i numer produktu (`pozycje.produkt_id`), a lustro zna parę `(kanal, produkt_id) → miniatura`.
//
// ⚠️ `pozycje.produkt_id` TRZYMA RODZICA, NIGDY WARIANTU — i właśnie dlatego ta
// droga w ogóle działa: `miniatura` w lustrze jest miniaturą PRODUKTU (Store API oddaje zdjęcia
// na produkcie, warianty jako samo `{ id, attributes }`), więc klucz i wartość mówią o tym
// samym bycie.
//
// ⚠️⚠️ POPRAWA JEST ŚCIŚLE JEDNOSTRONNA I TO JEST WARUNEK, NIE OSTROŻNOŚĆ. Ekran przestawiony
// na czytanie WYŁĄCZNIE nowej kolumny gasi także miniatury, które wcześniej działały: kolumna
// startuje pusta, więc usterka częściowa zamienia się w całkowitą aż do ręcznego odczytu
// katalogów (tak już raz było przy magazynie). Tutaj gałąź zapasowa ZOSTAJE: czego lustro nie
// zna, to renderuje się zgadywanym adresem. Nigdzie nie może być gorzej niż bez lustra — ani
// w sklepie, w którym zgadywanie trafia, ani na Allegro (które Store API nie ma w ogóle), ani
// w archiwum sprzed pierwszego odczytu katalogu.
import { adresMiniatury } from './miniatury.js';

// ⚠️ ZNAK ZEROWY JAKO ROZDZIELACZ, a nie myślnik ani dwukropek. Kanały to `sklep_b`, `sklep_a`,
// `allegro_a`…, a identyfikatory bywają napisami z Allegro — rozdzielacz, który może
// wystąpić w którejkolwiek z tych wartości, skleiłby ('a-b','c') i ('a','b-c') w jeden klucz,
// czyli pokazał operatorowi CUDZE zdjęcie. Znak zerowy nie występuje w żadnej z nich.
const ROZDZIELACZ = '\u0000';

/**
 * Klucz mapy lustra dla pary (kanał, produkt) — albo `null`, gdy pary nie ma.
 *
 * ⚠️ IDENTYFIKATOR ZAWSZE NAPISEM. `pozycje.produkt_id` jest kolumną INTEGER, a
 * `produkty_sklepowe.produkt_id` kolumną TEXT (identyfikator Allegro przychodzi napisem).
 * `Map` porównuje klucze przez `===`, więc 944 !== '944' rozminęłoby się z lustrem CICHO:
 * zielona suita, zero błędów i ani jednej miniatury więcej niż dziś.
 *
 * Brak którejkolwiek połowy pary NIE DAJE klucza. Pozycja dopisana ręcznie ma `produkt_id`
 * puste — klucz zbudowany z pustki trafiłby w wiersz, który o niej nic nie mówi.
 */
export function kluczLustra(kanal, produktId) {
  if (kanal === null || kanal === undefined || kanal === '') return null;
  if (produktId === null || produktId === undefined || produktId === '') return null;
  return `${String(kanal)}${ROZDZIELACZ}${String(produktId)}`;
}

// Adres z lustra ląduje wprost w atrybucie `src` naszego HTML-a, a lustro bierze się z cudzego
// API — ten sam warunek, co przy każdym innym adresie w domena/miniatury.js i z tego samego
// powodu. Adres, któremu odmawiamy, NIE gasi zdjęcia: schodzimy wtedy do gałęzi zapasowej.
const ADRES_HTTP = /^https?:\/\//i;

/**
 * REGUŁA — JEDNA, DLA CZTERECH EKRANÓW: lista zamówień, karta zamówienia, ekran nadania
 * i galeria na karcie produktu.
 *
 * ⚠️ ROZGAŁĘZIANIE PO EKRANIE BYŁOBY TĄ SAMĄ CHOROBĄ, KTÓRĄ LECZYMY. Zgadywany rozmiar żył
 * w czterech widokach naraz i dlatego jedna zmierzona nieprawda musiała być poprawiana
 * w czterech miejscach. Ta funkcja jest jedna właśnie po to, żeby następna poprawka reguły
 * była zmianą w JEDNYM pliku.
 *
 * `zLustra` = wartość kolumny `produkty_sklepowe.miniatura` (albo `null`, gdy produktu
 * w lustrze nie ma). `oryginal` = adres zdjęcia, który niesie sama pozycja.
 *
 * ⚠️ NIGDY NIE RZUCA — dokładnie jak `adresMiniatury`. Renderowanie listy albo karty nie ma
 * prawa paść na adresie o nieoczekiwanym kształcie.
 */
export function miniaturaZLustra(zLustra, oryginal) {
  if (typeof zLustra === 'string') {
    const s = zLustra.trim();
    if (s && ADRES_HTTP.test(s)) return s;
  }
  // ⚠️ TU KOŃCZY SIĘ JEDNOSTRONNOŚĆ I TEJ LINII NIE WOLNO USUNĄĆ. Bez niej sklep, w którym
  // zgadywanie trafia, Allegro i całe archiwum sprzed pierwszego odczytu katalogu straciłyby miniatury, które DZIŚ
  // działają — czyli powtórzyłby się błąd z naprawy magazynu.
  return adresMiniatury(oryginal);
}

/**
 * Ta sama reguła, ale z wyszukaniem w mapie lustra — postać, której używają ekrany zamówień
 * (galeria karty ma wiersz lustra pod ręką i woła `miniaturaZLustra` wprost).
 *
 * ⚠️ BRAK MAPY NIE RZUCA: ekran, który jej (jeszcze) nie zbudował, ma pokazać to, co dziś,
 * a nie 500 zamiast listy zamówień.
 */
export function miniaturaPozycji(lustro, kanal, produktId, oryginal, sku = null, lustroSku = null) {
  const klucz = kluczLustra(kanal, produktId);
  // ⚠️ `lustro` MUSI być `Map`, nie literałem obiektu — patrz komentarz przy `miniaturyLustra`
  // w oms/db/miniatury-lustra.js. `?.get?.` przepuszcza też brak mapy w ogóle.
  let zLustra = klucz === null ? null : lustro?.get?.(klucz);
  // Pozycja BEZ żadnego zdjęcia (ERLI nie przysyła go w zamówieniu) — miniatura produktu o tym samym SKU
  // z lustra magazynu (`miniaturySku`). Tylko wtedy: zdjęcie, które pozycja ma (sklep, Allegro), wygrywa jak dotąd.
  const bezZdjecia = typeof oryginal !== 'string' || !oryginal.trim();
  if ((zLustra === null || zLustra === undefined) && bezZdjecia && typeof sku === 'string' && sku.trim()) {
    zLustra = lustroSku?.get?.(sku.trim());
  }
  return miniaturaZLustra(zLustra, oryginal);
}
