import { bladOperatora } from './bledy.js';
import { zl } from './kwoty.js';
import { cenaPoRabacieGrosze } from './rabat.js';
import { cenaWdtGrosze } from './wdt.js';

// PRODUKT Z MAGAZYNU → POZYCJA ZAMÓWIENIA (21.08.2026, prośba właściciela).
//
// „Dzwoni klient, chce zamówić 3 szablony z naszej oferty. Klikam dodaj zamówienie i muszę
// ręcznie wpisywać nazwy i ceny." Do dziś zamówienie telefoniczne było JEDYNYM miejscem
// w panelu, gdzie cena wchodzi do zamówienia bez żadnego źródła — stąd i literówka w nazwie
// na fakturze, i cena sprzed podwyżki.
//
// Ten moduł jest CZYSTY: dostaje wiersz lustra katalogów (`produkty_sklepowe`) i oddaje
// gotową pozycję. Bez bazy, bez SQL-a, bez widoku.

// ⚠️⚠️ ALLEGRO NIGDY NIE JEST CENNIKIEM i to jest wymóg wprost ze zgłoszenia („ceny domyślne
// to ceny ze sklepów, nie z Allegro"), a nie ostrożność.
//
// Powód jest arytmetyczny, nie estetyczny: cena allegrowa ma wliczoną prowizję (rzędu
// kilkunastu procent), więc podstawiona do zamówienia telefonicznego zawyżałaby je o kwotę,
// której nikomu nie płacimy — a przy zamówieniu firmowym poszłaby wprost na fakturę.
// Lista jest ZAMKNIĘTA: kanał spoza niej nie jest cennikiem, choćby miał cenę.
//
// PRZ-060: lista, kolejność i nazwy cenników to KONFIGURACJA instalacji (`OMS_CENNIKI`,
// pierwszy wpis = cennik domyślny, zwykle detal), nie stała w kodzie. Bez niej cennikami są
// sklepy WooCommerce z `OMS_KANALY`, w ich kolejności, pod ich etykietą.

const KLUCZ_CENNIKA = /^[a-z][a-z0-9_-]*$/;

/**
 * Surowy `OMS_CENNIKI` → lista `{ kanal, nazwa }` albo `null`, gdy zmienna nie jest ustawiona.
 * Odmowa (wyjątek) przy złym kształcie — zła lista cenników to złe ceny na fakturze.
 */
export function parsujCenniki(tekst) {
  if (tekst === undefined || String(tekst).trim() === '') return null;
  let lista;
  try { lista = JSON.parse(tekst); } catch { throw new Error('OMS_CENNIKI: niepoprawny JSON'); }
  if (!Array.isArray(lista) || lista.length === 0) throw new Error('OMS_CENNIKI: oczekiwano niepustej listy');
  const widziane = new Set();
  for (const w of lista) {
    if (w === null || typeof w !== 'object' || Array.isArray(w) || typeof w.kanal !== 'string'
      || !KLUCZ_CENNIKA.test(w.kanal) || typeof w.nazwa !== 'string' || !w.nazwa.trim() || widziane.has(w.kanal)) {
      throw new Error('OMS_CENNIKI: każdy wpis to {"kanal":"klucz","nazwa":"tekst"}, kanały bez powtórzeń');
    }
    widziane.add(w.kanal);
  }
  return lista.map(({ kanal, nazwa }) => ({ kanal, nazwa: nazwa.trim() }));
}

/**
 * Cenniki instalacji: `{ kanaly, domyslny, nazwy }`.
 *
 * `lista` — wynik `parsujCenniki` (albo `null`), `definicje` — definicje kanałów (`OMS_KANALY`).
 * Kanał zdefiniowany jako Allegro nie może być cennikiem nawet z jawnej listy.
 */
export function cenniki({ lista = null, definicje = [] } = {}) {
  const allegrowe = new Set(definicje.filter((d) => d.typ === 'allegro').map((d) => d.klucz));
  const wpisy = lista ?? definicje.filter((d) => d.typ === 'woo').map((d) => ({ kanal: d.klucz, nazwa: d.etykieta ?? d.klucz }));
  for (const w of wpisy) {
    if (allegrowe.has(w.kanal)) throw new Error(`OMS_CENNIKI: kanał „${w.kanal}" jest kanałem Allegro, a Allegro nie jest cennikiem`);
  }
  return Object.freeze({
    kanaly: Object.freeze(wpisy.map((w) => w.kanal)),
    domyslny: wpisy[0]?.kanal ?? null,
    nazwy: Object.freeze(Object.fromEntries(wpisy.map((w) => [w.kanal, w.nazwa]))),
  });
}

const BEZ_CENNIKOW = cenniki();

/** „A", „A i B", „A, B i C" — nazwy cenników do zdania dla operatora. */
function wyliczenie(nazwy) {
  if (nazwy.length <= 1) return nazwy.join('');
  return `${nazwy.slice(0, -1).join(', ')} i ${nazwy[nazwy.length - 1]}`;
}

/**
 * Z którego cennika liczyć ceny.
 *
 * Kolejność: świadomy wybór operatora → kanał zamówienia → detal. Zamówienie ze sklepu ma
 * dostać ceny TEGO sklepu (dopisana pozycja stanie obok pozycji kupionych po tych cenach),
 * a zamówienie ręczne nie ma kanału, więc rozstrzyga wybór człowieka albo domyślny detal.
 *
 * ⚠️ Kanał allegrowy zamówienia NIE przenosi się na cennik — dopisując pozycję do zamówienia
 * z Allegro bierzemy cenę sklepową, bo to my ją ustalamy z klientem, a nie Allegro.
 */
export function cennikDlaZamowienia({ sklepZamowienia = null, wybrany = null } = {}, cennikiInstalacji = BEZ_CENNIKOW) {
  const { kanaly, domyslny } = cennikiInstalacji;
  const wybor = String(wybrany ?? '').trim();
  if (kanaly.includes(wybor)) return wybor;
  const sklep = String(sklepZamowienia ?? '').trim();
  if (kanaly.includes(sklep)) return sklep;
  return domyslny;
}

/**
 * Nazwa pozycji: nazwa produktu plus rozmiar wariantu — ale TYLKO gdy nazwa go jeszcze
 * nie niesie.
 *
 * ⚠️ Przy szablonach to rozmiar jest tym, co się myli przy telefonie, więc musi być w nazwie
 * pozycji (klient dostanie ją na fakturze). Część produktów ma go już w nazwie („…logo 50cm"),
 * część trzyma go w wariancie — doklejenie na ślepo dawałoby „Pieszy 70x100 70x100".
 * Porównanie po ASCII i bez wielkości liter, tak samo jak szukanie w lustrze.
 */
export function nazwaPozycji({ nazwa, rozmiar_tekst: rozmiar } = {}) {
  const podstawa = String(nazwa ?? '').trim();
  const dodatek = String(rozmiar ?? '').trim();
  if (!dodatek) return podstawa;
  if (podstawa.toLowerCase().includes(dodatek.toLowerCase())) return podstawa;
  return `${podstawa} ${dodatek}`;
}

/**
 * Rozmiar DO POKAZANIA obok nazwy — albo `null`, gdy nic by nie wniósł.
 *
 * ⚠️ TO NIE JEST KOSMETYKA, tylko konsekwencja tego, jak powstaje lustro: przy produkcie
 * BEZ atrybutu rozmiaru odczyt katalogu wpisuje w `rozmiar_tekst` całą NAZWĘ
 * (`rozmiarZAtrybutow(...) ?? nazwa` w services/magazyn-sync.js). Pokazane wprost dawało
 * na liście „Dwa kotki - aplikacja 30x48cm — Dwa kotki - aplikacja 30x48cm", czyli szum
 * dokładnie tam, gdzie operator ma przy telefonie odróżnić rozmiary od siebie.
 *
 * Ta sama reguła, co w `nazwaPozycji` wyżej, i to jest cały powód, dla którego stoi obok:
 * ekran ma pokazywać rozmiar wtedy i tylko wtedy, gdy nazwa pozycji też go dostanie.
 */
export function rozmiarDoPokazania({ nazwa, rozmiar_tekst: rozmiar } = {}) {
  const podstawa = String(nazwa ?? '').trim();
  const dodatek = String(rozmiar ?? '').trim();
  if (!dodatek) return null;
  return podstawa.toLowerCase().includes(dodatek.toLowerCase()) ? null : dodatek;
}

/** Ilość z formularza — całkowita, dodatnia, bez górnej granicy poza zdrowym rozsądkiem. */
function parsujIlosc(surowa) {
  const tekst = String(surowa ?? '').trim().replace(',', '.');
  const n = Number(tekst === '' ? 1 : tekst);
  if (!Number.isInteger(n) || n <= 0) {
    throw bladOperatora(`Ilość musi być liczbą całkowitą większą od zera, a jest „${surowa}".`);
  }
  if (n > 9999) throw bladOperatora('Ilość powyżej 9999 sztuk wygląda na pomyłkę — wpisz mniejszą.');
  return n;
}

/**
 * Wiersz lustra + ilość → pozycja gotowa do dopisania do zamówienia.
 *
 * ⚠️ CENA POCHODZI Z WIERSZA, NIGDY Z FORMULARZA. Trasa dostaje z ekranu wyłącznie „co
 * i ile" (kanał, produkt, wariant, ilość) i cenę czyta tu, z lustra — pole w HTML-u da się
 * podmienić, a to są pieniądze, które klient zapłaci.
 *
 * ⚠️ NAZWA I CENA TO MIGAWKA, NIE ŁĄCZE. Podwyżka w sklepie nie ma prawa zmienić kwoty
 * w zamówieniu sprzed tygodnia — dokładnie tak samo, jak nie zmienia jej dziś przy
 * zamówieniu sklepowym.
 *
 * ⚠️ RABAT STAŁEGO KLIENTA WCHODZI TUTAJ, a cena katalogowa jedzie OBOK (21.08.2026).
 * Bez zapisanej ceny sprzed rabatu nie dałoby się ani pokazać na karcie, skąd wzięła się
 * kwota, ani przeliczyć zamówienia po zmianie rabatu, ani wrócić do cen katalogowych —
 * a „rabat 0%" jest jedyną uczciwą drogą powrotu po pomyłce (domain/rabat.js).
 * Zapisujemy ją ZAWSZE, także przy rabacie zerowym: pozycja bez ceny katalogowej jest dla
 * przeliczenia niewidzialna, więc rabat wpisany na karcie po dodaniu towaru nie miałby
 * czego dotknąć.
 */
export function pozycjaZProduktu(produkt, iloscSurowa, { rabatProcent = 0, wdt = false, cenniki: cennikiInstalacji = BEZ_CENNIKOW } = {}) {
  if (!produkt) throw bladOperatora('Nie ma takiego produktu w magazynie — odczytaj katalogi i spróbuj jeszcze raz.');
  const { kanaly, nazwy } = cennikiInstalacji;
  if (!kanaly.includes(String(produkt.kanal ?? ''))) {
    throw bladOperatora(kanaly.length
      ? `Kanał „${produkt.kanal}" nie jest cennikiem — ceny biorą się wyłącznie ze sklepów `
        + `${wyliczenie(kanaly.map((k) => nazwy[k]))}.`
      : `Kanał „${produkt.kanal}" nie jest cennikiem — ta instalacja nie ma żadnego cennika (OMS_CENNIKI, OMS_KANALY).`);
  }
  const cenaGr = produkt.cena_gr;
  if (!Number.isInteger(cenaGr) || cenaGr <= 0) {
    throw bladOperatora(
      `Produkt „${produkt.nazwa}" nie ma ceny w cenniku ${nazwy[produkt.kanal]} — `
      + 'dopisz go ręcznie z ceną albo wybierz drugi cennik.',
    );
  }
  const ilosc = parsujIlosc(iloscSurowa);
  // Cena PO rabacie liczy się w groszach i dopiero potem mnoży przez ilość — patrz
  // `cenaPoRabacieGrosze`. Rabat zerowy oddaje cenę katalogową co do grosza, więc ta jedna
  // ścieżka obsługuje oba przypadki i nie ma drugiej, „bezrabatowej", która mogłaby się
  // z nią rozjechać.
  // Klient WDT (nabywca z numerem VAT-UE): po rabacie zdejmujemy jeszcze 23% wliczone
  // w cenę sklepową (÷1,23 NA SZTUCE — wzorzec Apilo, patrz cenaWdtGrosze). Zgłoszenie
  // właściciela 26.08: wstawka z samym rabatem zostawiała mu 19 pozycji do ręcznego
  // dzielenia — czyli dokładnie ten rodzaj przepisywania, który ten moduł miał skasować.
  const poRabacieGr = cenaPoRabacieGrosze(cenaGr, rabatProcent);
  const doZaplatyGr = wdt ? cenaWdtGrosze(poRabacieGr) : poRabacieGr;
  // Identyfikator produktu ma sens WYŁĄCZNIE liczbowy: kolumna `pozycje.produkt_id` jest
  // INTEGER (identyfikatory Woo), a lustro trzyma je jako tekst, bo mieści też Allegro.
  // Nie-liczba idzie jako brak, a nie jako NaN — pozycja ma powstać nawet wtedy.
  const produktId = Number(produkt.produkt_id);
  const wariant = String(produkt.wariant_id ?? '').trim();
  return {
    nazwa: nazwaPozycji(produkt),
    sku: produkt.sku_sklepu ?? null,
    ilosc,
    cena_brutto: zl(doZaplatyGr),
    brutto_linii: zl(doZaplatyGr * ilosc),
    // Cena z cennika, PRZED rabatem — patrz komentarz przy sygnaturze.
    cena_katalogowa: zl(cenaGr),
    produkt_id: Number.isFinite(produktId) ? produktId : null,
    // ⚠️ WARIANT JEST TU CAŁYM SENSEM KOLUMNY `pozycje.wariant_id`. Wybierając „Pieszy
    // 70×100" operator wybiera WARIANT, a `produkt_id` trzyma RODZICA — bez tego z pozycji
    // nie dałoby się odczytać, jaki rozmiar poszedł, i zamówienie telefoniczne byłoby
    // od pierwszego dnia uboższe niż sklepowe.
    wariant_id: wariant === '' ? null : wariant,
  };
}
