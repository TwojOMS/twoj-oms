// Miniatury produktów w kolumnie „Produkty" na stronie głównej.
//
// Dwie reguły, rozdzielone celowo:
//  - `zdjecieLinii` (WooCommerce) i `zdjecieOferty` (Allegro) mówią, CO ZAPISUJEMY
//    z odpowiedzi źródła — adres w pełnym rozmiarze, dokładnie tak, jak przyszedł;
//  - `adresMiniatury` mówi, CO POKAZUJEMY (wariant 150×150).
//
// ⚠️ W bazie leży adres ORYGINAŁU, nie wyliczony adres miniatury — i to jest istotne.
// Reguła wyprowadzania rozmiaru jest zgadywaniem po nazwie pliku (patrz niżej), więc
// prędzej czy później będzie wymagała poprawki. Trzymanie w bazie wartości surowej
// znaczy, że taka poprawka jest zmianą w widoku, a nie migracją danych — poller nie
// wróciłby po nie po raz drugi (przewodnik OMS, 4.7).

/**
 * Adres zdjęcia z pozycji zamówienia WooCommerce. Woo podaje je jako
 * `image: { id, src }` — przy czym `id` bywa raz liczbą, raz napisem („1142"), więc go
 * w ogóle nie czytamy: interesuje nas wyłącznie `src`.
 */
export function zdjecieLinii(linia) {
  const src = linia?.image?.src;
  if (typeof src !== 'string') return null;
  const s = src.trim();
  if (!s) return null;
  // Adres ze sklepu ląduje wprost w atrybucie `src` naszego HTML-a. Sklep jest nasz, ale
  // wpuszczanie tam czegokolwiek poza http(s) nie ma uzasadnienia i kosztuje jedną linię.
  return /^https?:\/\//i.test(s) ? s : null;
}

/**
 * Adres zdjęcia głównego OFERTY ALLEGRO — z odpowiedzi `GET /sale/product-offers/{offerId}`.
 *
 * ⚠️ FORMULARZ ZAKUPOWY ZDJĘCIA NIE NIESIE. `lineItems[].offer` to `{ id, name, external,
 * productSet, hsNumber }` i nic więcej (zmierzone na żywym koncie 05.08.2026), więc adres
 * trzeba dopytać osobno — stąd pamięć podręczna `zdjecia_ofert` (db/zdjecia-ofert.js).
 *
 * ⚠️ NIE `GET /sale/offers/{offerId}` — Allegro WYCOFAŁO ten zasób i oddaje 403
 * („This resource is no longer supported").
 *
 * `images` przychodzi jako tablica ADRESÓW (napisów), a nie obiektów; pierwszy element to
 * zdjęcie główne. Kształt inny niż zmierzony czytamy jako „brak zdjęcia", a nie jako błąd:
 * pozycja pokaże wtedy samą nazwę, dokładnie tak jak dziś.
 */
export function zdjecieOferty(oferta) {
  const obrazy = oferta?.images;
  if (!Array.isArray(obrazy)) return null;
  const pierwszy = obrazy[0];
  if (typeof pierwszy !== 'string') return null;
  const s = pierwszy.trim();
  if (!s) return null;
  // Ten sam warunek, co przy zdjęciu ze sklepu i z tego samego powodu: adres ląduje wprost
  // w atrybucie `src` naszego HTML-a.
  return /^https?:\/\//i.test(s) ? s : null;
}

/**
 * Adres zdjęcia POZYCJI zamówienia — jedna reguła dla obu kanałów.
 *
 * Pozycja ze sklepu niesie adres we WŁASNEJ kolumnie `pozycje.zdjecie_url` (zapisuje ją
 * poller razem z zamówieniem). Pozycja z Allegro nie ma go skąd wziąć przy zapisie, więc
 * adres dokłada dopiero odczyt — z pamięci podręcznej kluczowanej ofertą (kolumna
 * `zdjecie_oferty` w złączeniu, db/zamowienia.js).
 *
 * ⚠️ KOLUMNA POZYCJI WYGRYWA. Gdyby kiedyś pozycja miała OBA źródła, prawdą jest to, co
 * przyszło Z ZAMÓWIENIEM — pamięć ofert mówi o ofercie DZIŚ, a zamówienie o tym, co klient
 * wtedy kupił. Dla sklepów ta gałąź nie zmienia niczego: `oferta_id` mają puste, więc
 * złączenie nigdy nie trafia i `zdjecie_oferty` jest tam zawsze `undefined`.
 */
export function zdjeciePozycji(pozycja) {
  return pozycja?.zdjecie_url ?? pozycja?.zdjecie_oferty ?? null;
}

// Rozmiar generowany przez WordPressa dla każdego wgranego zdjęcia (domyślna „miniatura").
// 150 px na kwadrat 38 px wygląda na zapas, ale to najmniejszy rozmiar, który WP tworzy
// ZAWSZE — a ekran bywa oglądany w powiększeniu.
const ROZMIAR = '150x150';

// Rozszerzenie na końcu ŚCIEŻKI (przed ewentualnym `?` albo `#`). Zmierzone na prawdziwych
// zdjęciach ze sklepu B: oryginał ~87 KB, wariant 150×150 ~4 KB — dwadzieścia razy
// mniej na każdy wiersz tabeli.
const ROZSZERZENIE = /(\.[a-z0-9]+)(?=(?:[?#]|$))/i;

// ⚠️ ALLEGRO TRZYMA WARIANT ROZMIARU W ŚCIEŻCE, NIE W NAZWIE PLIKU — adres nie ma
// rozszerzenia w ogóle, więc reguła WordPressa (wyżej) przeszłaby obok niego bez śladu
// i panel ciągnąłby na listę oryginały.
//
//   https://9.allegroimg.com/original/03e7d6/772bd11044a79ce6967b62cfa489
//                            ^^^^^^^^ ten segment podmieniamy
//
// Poddomena bywa różna (`9.`, `2.`, `5.`, `f.`) — stąd `(?:[a-z0-9-]+\.)*` zamiast wpisanej
// na sztywno. Warunek celowo NIE JEST „adres zawiera /original/": to musi być host Allegro,
// bo inaczej ta reguła sięgałaby po adresy ze sklepu.
//
// Rozmiary ZMIERZONE na żywym zdjęciu (05.08.2026), wszystkie HTTP 200 i `image/jpeg`:
// `original` = `s720` → 66 KB, `s360` = `s256` → 18 KB, **`s150` → 7,9 KB**, `s128` → 4,4 KB.
// Bierzemy `s150`, bo panel renderuje kwadrat 38 px z zapasem do 150 px — to samo kryterium,
// co przy WooCommerce, i wariant bez skalowania W GÓRĘ.
const ROZMIAR_ALLEGRO = 's150';
const ORYGINAL_ALLEGRO = /^(https?:\/\/(?:[a-z0-9-]+\.)*allegroimg\.com\/)original(?=\/)/i;

/**
 * Adres wariantu 150×150, czyli pliku, który WordPress wygenerował obok oryginału.
 *
 * ⚠️ TO JEST WYPROWADZENIE Z NAZWY, NIE ODPYTANIE SKLEPU — i ma jeden znany przypadek
 * brzegowy: zdjęcia mniejszego niż 150 px w którymkolwiek wymiarze WordPress nie przycina,
 * więc taki plik nie istnieje i przeglądarka pokaże pustą ramkę. Świadomie na to idziemy,
 * bo alternatywą jest osobne zapytanie do sklepu na każdą pozycję. Skutek jest znośny,
 * bo `alt` niesie nazwę produktu, a nazwa i tak stoi obok miniatury — brak zdjęcia nie
 * zabiera z ekranu ŻADNEJ informacji. Zdjęcia produktowe w tym sklepie mają po kilkaset
 * pikseli (sprawdzone na żywym API 01.08.2026).
 *
 * ⚠️ JEDNA FUNKCJA NA OBA KANAŁY, i to jest decyzja. Widoki (lista, karta, ekran nadania)
 * NIE WIEDZĄ, z którego kanału jest wiersz — i wiedzieć nie mają. Rozstrzyga sam adres:
 * host `allegroimg.com` idzie regułą segmentu ścieżki, wszystko inne regułą WordPressa.
 * Osobna funkcja dla Allegro znaczyłaby `if` po kanale w trzech widokach naraz, a to
 * dokładnie ta kopia reguły, której zakazuje niezmiennik 4.13c.
 *
 * ⚠️ NIGDY NIE RZUCA. Adres o nieoczekiwanym kształcie (bez `/original/`, bez rozszerzenia,
 * z dziwną poddomeną) wraca BEZ ZMIAN — pokazujemy wtedy oryginał, czyli zdjęcie o rozmiar
 * za duże, zamiast wywalać renderowanie listy albo karty.
 */
export function adresMiniatury(src) {
  if (typeof src !== 'string' || !src.trim()) return null;
  const s = src.trim();
  // Allegro NAJPIERW: jego adresy nie mają rozszerzenia, więc reguła WordPressa i tak by
  // ich nie ruszyła — ale kolejność ma być widoczna, a nie wynikać z przypadku.
  if (ORYGINAL_ALLEGRO.test(s)) return s.replace(ORYGINAL_ALLEGRO, `$1${ROZMIAR_ALLEGRO}`);
  // Adres bez rozszerzenia zostaje bez zmian: uczciwiej pokazać oryginał niż skleić adres,
  // pod którym na pewno nic nie leży.
  return ROZSZERZENIE.test(s) ? s.replace(ROZSZERZENIE, `-${ROZMIAR}$1`) : s;
}

// ================================================================================
// MINIATURA WPROST ZE SKLEPU (Store API) — koniec zgadywania w magazynie
//
// ⚠️⚠️ REGUŁA `adresMiniatury` (wyżej) OKAZAŁA SIĘ NIEPRAWDZIWA i to jest zmierzone, a nie
// przypuszczone. Sprawdzone 2026-08-12 na WSZYSTKICH adresach obu sklepów:
//
//   sklep B — 103 zdjęcia, 103 miniatury,   0 błędów (0%)
//   sklep A — 684 zdjęcia,  76 miniatur,  608 błędów 404 (89%)
//
// Powód: sklep A ma WŁASNY rozmiar miniatury `247x296`, a nie WordPressowy `150x150`.
// W sklepie B zgadywanie trafiało przypadkiem — tamten sklep akurat używa 150×150. Oryginały są
// zdrowe (wszystkie 684 odpowiadają 200), więc jedyną przyczyną pustych ramek na liście
// magazynu było doklejanie rozmiaru do nazwy pliku.
//
// Komentarz na górze tego pliku sam to przewidział („reguła wyprowadzania rozmiaru jest
// zgadywaniem po nazwie pliku… prędzej czy później będzie wymagała poprawki") i CELOWO
// zostawił w bazie adres oryginału — dzięki temu poprawka jest zmianą reguły, a nie
// odtwarzaniem danych, po które poller nie wróci.
//
// ⚠️ `adresMiniatury` ZOSTAJE i nie wolno jej usunąć: żyje z niej lista zamówień, ekran
// nadania i karta zamówienia (`web/routes/zamowienia.js`, `views/lista.ejs`, `views/nadaj.ejs`,
// `views/zamowienie.ejs`) oraz galeria na karcie produktu. Ta zmiana zdejmuje zgadywanie
// WYŁĄCZNIE z listy magazynu, bo tylko tam mamy dokąd zapisać wartość prawdziwą.
//
// ⚠️⚠️ DOPISANE 2026-08-12 (zgłoszenie „zdjęcia produktów nie ładują się na ekranach
// zamówień"): pozostałe cztery ekrany też już NIE zgadują pierwszym wyborem — biorą adres
// z tego samego lustra, po parze `(zamowienia.sklep, pozycje.produkt_id)`. Regułę „lustro
// wygrywa, zgadywanie zostaje" trzyma `domain/miniatura-pozycji.js`, JEDNA dla wszystkich
// czterech.
//
// ⚠️⚠️ ALE `adresMiniatury` NIE JEST PRZEZ TO MARTWA — jest GAŁĘZIĄ ZAPASOWĄ I MUSI NIĄ
// ZOSTAĆ. To ona obsługuje wszystko, czego lustro nie zna: Allegro (nie ma Store API,
// więc wariant `s150` wyprowadzamy ze ścieżki i to jest droga POPRAWNA), zamówienia
// archiwalne sprzed pierwszego odczytu katalogu, pozycje dopisane ręcznie z własnym
// adresem zdjęcia oraz drugie i dalsze zdjęcia w galerii karty. Usunięcie jej albo
// przecięcie tej gałęzi ZGASIŁOBY zdjęcia, które dziś działają — dokładnie tak, jak
// stało się dzień wcześniej w magazynie, gdzie ekran przestawiono na czytanie wyłącznie
// nowej (pustej wtedy) kolumny.

/**
 * Odpowiedź Store API sklepu (`/wp-json/wc/store/v1/products`) → MAPA
 * `id produktu (napisem)` → `adres miniatury`.
 *
 * ⚠️ TO JEST JEDYNE ŹRÓDŁO PRAWDY O MINIATURZE. Store API przy każdym zdjęciu oddaje gotowe
 * `thumbnail` w rozmiarze, który TEN sklep naprawdę wygenerował — zmierzone: sklep A daje
 * `…-247x296.jpg`, sklep B `…-300x300.png`. Żadna reguła po nazwie pliku nie umiałaby
 * odgadnąć obu naraz, a druga próba zgadywania skończyłaby się tak samo jak pierwsza.
 *
 * ⚠️ STORE API UKRYWA SZKICE — i to nam NIE PRZESZKADZA, a nie jest usterką do naprawienia.
 * Publiczny katalog pokazuje wyłącznie produkty opublikowane, a magazyn i tak czyta sklepy
 * z `status=publish` (patrz `woo/client.js`). Zbiory się więc pokrywają; brak szkiców w tej
 * mapie jest oczekiwany i nikt nie powinien go zgłaszać jako braku miniatur.
 *
 * ⚠️ ZDJĘCIA SIEDZĄ NA PRODUKCIE, NIE NA WARIANCIE. Store API oddaje warianty jako samo
 * `variations: [{ id, attributes }]` — bez zdjęć. Dlatego kluczem jest identyfikator
 * PRODUKTU, a wariant w lustrze bierze miniaturę RODZICA (`services/magazyn-sync.js`).
 * To jest poprawne, a nie zastępcze: wariant zwykle nie ma własnego zdjęcia, a gdy ma,
 * galeria wariantu i tak zaczyna się od zdjęcia rodzica.
 *
 * ⚠️ KLUCZ JEST NAPISEM, bo `produkty_sklepowe.produkt_id` jest kolumną TEXT (identyfikator
 * Allegro przychodzi napisem). `Map` porównuje klucze przez `===`, więc mapa kluczowana
 * liczbą rozminęłaby się z lustrem CICHO — 944 !== '944' i ani jeden wiersz nie dostałby
 * miniatury, przy zielonej suicie i bez jednego błędu.
 *
 * ⚠️ CZEGO NIE ZNAMY, TEGO NIE WPISUJEMY. Produkt bez `thumbnail` po prostu nie ma wpisu —
 * nigdy oryginału ani adresu zgadniętego „na wszelki wypadek". Pusta komórka jest dziś i tak
 * stanem widocznym, a 608 oryginałów po ~250 kB to ponad 150 MB na jednej stronie listy.
 *
 * ⚠️ NIGDY NIE RZUCA. Store API to cudze API czytane bez uwierzytelniania — odpowiedź
 * o nieznanym kształcie daje PUSTĄ mapę (czyli „miniatur nie znamy"), a nie wyjątek, który
 * zatrzymałby odczyt całego katalogu.
 */
export function miniaturyZeStoreApi(produkty) {
  const mapa = new Map();
  if (!Array.isArray(produkty)) return mapa;
  for (const p of produkty) {
    const id = p?.id;
    if (id === null || id === undefined || id === '') continue;
    // Pierwsze zdjęcie jest głównym — tym samym, które lustro trzyma na czele `zdjecia_json`.
    const adres = (Array.isArray(p.images) ? p.images : [])[0]?.thumbnail;
    if (typeof adres !== 'string') continue;
    const s = adres.trim();
    // Ten sam warunek, co przy wszystkich pozostałych adresach w tym module i z tego samego
    // powodu: wartość ląduje wprost w atrybucie `src` naszego HTML-a.
    if (!s || !/^https?:\/\//i.test(s)) continue;
    mapa.set(String(id), s);
  }
  return mapa;
}
