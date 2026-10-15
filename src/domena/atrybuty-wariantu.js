// Atrybuty wariacyjne wariantu — jedno miejsce prawdy o tym, CO sklep zapisal jako os
// podzialu produktu wariantowego i jak my to trzymamy w lustrze.
//
// ⚠️⚠️ TRZY STANY, NIE DWA, i to jest cala tresc tego pliku. Kolumny `atrybuty_json` NIE BYLO
// do 2026-08-11 — dochodzi migracja, a 1459 istniejacych wierszy dostanie w niej NULL az do
// najblizszego odczytu katalogow. Stad:
//   `null`  — NIE WIEMY (lustro nie zna jeszcze atrybutow tego wariantu);
//   `[]`    — WIEMY, ze sklep nie dal ZADNEGO atrybutu;
//   `[...]` — WIEMY, jakie osie podzialu wskazal sklep.
// Sklejenie pierwszych dwoch stanow konczy sie albo zalozeniem 20 nierozroznialnych wzorow
// ze starych danych, albo odeslaniem wlasciciela do naprawy sklepu, w ktorym nie ma czego
// naprawiac. Oba bledy sa ciche.

const napis = (x) => (typeof x === 'string' ? x.trim() : '');

/**
 * Wariant WooCommerce → tresc kolumny `atrybuty_json`. Zapisujaca polowa pary; czytajaca
 * (`atrybutyWariantu`) stoi tuz nizej, zeby ksztalt nie mial jak sie rozjechac.
 *
 * ⚠️⚠️ ZRODLEM JEST `attributes` Z ODPOWIEDZI API, NIGDY PERMALINK. Wariant niesie te sama
 * informacje w adresie (`?attribute_uklad=RÓWNOLEGLE`) i kusi, zeby ja stamtad wyparsowac —
 * ale permalink jest OZDOBA: sklep moze go przebudowac, przepisac na identyfikatory albo
 * wylaczyc ladne adresy, a wtedy panel czyta smiec i nie ma jak tego zauwazyc. Wzory zakladaja
 * sie hurtem i numeruja nieodwracalnie, wiec cicho przeczytany smiec kosztuje caly rejestr.
 *
 * ⚠️ ZAWSZE TABLICA, TAKZE PUSTA. `[]` znaczy „odczyt byl i sklep nie dal atrybutu" — to jest
 * WIEDZA, po ktorej panel mowi wlascicielowi „popraw sklep". `null` znaczyloby „nie czytalismy".
 *
 * ⚠️ Wartosc pusta wypada. Woo zapisuje tak wariant „dowolny <atrybut>" (option: ''), czyli
 * wariant, ktory tej osi WLASNIE NIE ustala — do nazwy wzoru nie ma z niego czego wziac.
 */
export function atrybutyZWariantu(wariant) {
  const surowe = Array.isArray(wariant?.attributes) ? wariant.attributes : [];
  return surowe
    .map((a) => ({ nazwa: napis(a?.name), wartosc: napis(a?.option) }))
    .filter((a) => a.nazwa && a.wartosc);
}

/**
 * Atrybuty wariantu z WIERSZA LUSTRA. `null` znaczy „nie wiemy" (patrz wyzej).
 *
 * ⚠️ POPSUTY JSON TEZ ODDAJE `null`, a nie pusta liste — i to jest ROZNICA wobec
 * `kategorie_json` w `wzor-z-produktu.js`, gdzie smiec daje `[]`. Tam pusta lista znaczy
 * „bez kategorii" i jest nieszkodliwa; TUTAJ pusta lista jest twierdzeniem („sklep nie dal
 * atrybutu"), po ktorym panel kaze wlascicielowi poprawic sklep. Z popsutego napisu takiego
 * twierdzenia postawic nie wolno.
 */
export function atrybutyWariantu(produkt) {
  const surowy = produkt?.atrybuty_json;
  if (typeof surowy !== 'string' || !surowy.trim()) return null;
  let lista;
  try {
    lista = JSON.parse(surowy);
  } catch {
    return null;
  }
  if (!Array.isArray(lista)) return null;
  return lista
    .map((a) => ({ nazwa: napis(a?.nazwa), wartosc: napis(a?.wartosc) }))
    .filter((a) => a.nazwa && a.wartosc);
}

/**
 * Atrybuty, ktore NIE ROBIA z wariantu osobnego wzoru — i dwa rozne powody, dla ktorych nie.
 *
 * `cena`: „ten sam wzor po 79/99/119 zl" nie jest trzema wzorami. Spec §0d: panel nie ma jak
 *   zgadnac, ktora cena to ktory rozmiar, i zgadywac nie bedzie.
 * `rozmiar`: rozmiar ma WLASNE kolumny (`szerokosc_mm`/`wysokosc_mm`), wlasny filtr braków
 *   i wlasna kolumne na liscie — jest juz rozroznieniem. Wpuszczony tutaj dopisalby ~229
 *   poprawnie opisanym wariantom PRO rozmiar do NAZWY („Pieszy — 70 x 100 cm"), czyli
 *   zepsulby glowna sciezke modulu przy naprawianiu skrajnego przypadku.
 *
 * ⚠️ Porownanie po znormalizowanej nazwie, DOKLADNE (nie „zawiera") — ta sama zasada, co przy
 * `ATRYBUT_ROZMIARU` w `services/magazyn-sync.js`: „Rozmiar wzoru" i „Rozmiar" moga znaczyc
 * co innego, a magazyn trzyma wymiar ARKUSZA.
 */
const NIE_SA_OSIA = new Set(['cena', 'rozmiar']);

export function osiePodzialu(atrybuty) {
  return (atrybuty ?? []).filter((a) => !NIE_SA_OSIA.has(napis(a?.nazwa).toLowerCase()));
}

/**
 * Nazwa wzoru niosaca wartosci osi podzialu („Woodland" → „Woodland — Wiewiórka").
 *
 * ⚠️⚠️ BEZ TEGO Z JEDNEGO RODZICA POWSTAJA WZORY NIEROZROZNIALNE. `Woodland` ma trzy warianty
 * (Wiewiórka / Zając / Łoś), wiec trzy wzory — a te trzy wiersze rozniacych sie NICZYM na
 * liscie, w filtrze i w generatorze SKU sa gorsze niz brak wzoru: w Etapie 2 „przygotuj pliki"
 * wyslaloby na ploter losowy z trzech.
 *
 * ⚠️ WARTOSCI PRZEPISUJEMY DOSLOWNIE. „Wiewiórka" i „NAPRZEMIENNIE" przyszly ze sklepu i tak
 * je zna wlasciciel; normalizowanie wielkosci liter albo zdejmowanie ogonkow robiloby z nazwy
 * wzoru napis, ktorego nie ma po drugiej stronie — a to po niej czlowiek szuka folderu na NAS-ie.
 *
 * ⚠️ WSZYSTKIE osie, nie „pierwsza z brzegu". `CYFRY wys. 90cm (Arial)` dzieli sie po czcionce
 * I po cyfrze; wybranie jednej z nich bylo by zgadywaniem, ktora z nich rozroznia — a pomylka
 * daje z powrotem nazwy powtorzone.
 */
export function nazwaZOsiami(nazwa, osie) {
  const wartosci = (osie ?? []).map((a) => napis(a?.wartosc)).filter(Boolean);
  return wartosci.length ? `${nazwa} — ${wartosci.join(', ')}` : nazwa;
}
