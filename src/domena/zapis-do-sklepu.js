// CO I GDZIE WYSLAC DO SKLEPU — regula czysta. Zadnego HTTP, zadnej bazy: tutaj rozstrzyga
// sie WYLACZNIE, ktory produkt dostanie ktore pole, pod jakim adresem i w jakiej jednostce.
// Zapytania robi `services/magazyn-zapis.js`, ekran sklada `web/routes/magazyn.js`.
//
// ⚠️⚠️ TO JEST OSTATNIA BARIERA PRZED ZAPISEM NA ZYWY SKLEP, ktory SPRZEDAJE. Zapis jest
// NIEODWRACALNY Z PANELU: nie ma „cofnij", bo cofniecie znaczyloby drugi zapis do sklepu,
// a panel nie trzyma tego, co bylo. Stad `opis` przy kazdej pozycji — STARE → NOWE — a nie
// sama liczba pozycji.
//
// PIEC ROZSTRZYGNIEC, KTORE TEN PLIK NIESIE:
//
// ⚠️⚠️ (1) SCIEZKA ROZSTRZYGA RODZIC vs WARIANT. Produkt wariantowy:
// `products/{produkt_id}/variations/{wariant_id}`, prosty: `products/{produkt_id}`. Zapis SKU
// NA RODZICA produktu wariantowego jest w WooCommerce LEGALNY I CICHY — nie da bledu, odpowie
// 200, a numer nie pojawi sie na wariancie, czyli tam, gdzie go szukamy i gdzie zyje cena
// (zmierzone: rodzic „Grzybek" ma SKU puste, warianty `PC-GRZ-117` / `PC-GRZ-118`).
//
// ⚠️⚠️ (2) PANEL WYSYLA WYLACZNIE `sku` I `dimensions`. Nigdy ceny, nazwy, kategorii, zdjec,
// opisu ani stanu magazynowego — to niezmiennik CALEGO modulu, nie ostroznosc tego pliku.
// Magazyn nie prowadzi stanow magazynowych i nie czyta `stock_quantity`.
//
// ⚠️⚠️ (3) JEDNOSTKA PRZELICZANA NA GRANICY. Kolumny sa w MILIMETRACH, sklep ma wlasna
// (`woocommerce_dimension_unit`). Zalozenie „to na pewno centymetry" daje produkt 70 MILIMETROW
// zamiast 70 cm — cicho i za pieniadze. Jednostki, ktorej nie znamy, NIE ZGADUJEMY.
//
// ⚠️⚠️ (4) NIEPUSTE SKU W SKLEPIE JEST TOZSAMOSCIA PRODUKTU i nie ma prawa zostac nadpisane.
// Regula stoi tutaj (`czyWolnoNadpisac`) i jest wolana DWA RAZY: przy podgladzie — z lustra,
// i przy zapisie — ze stanu ZYWEGO, odczytanego tuz przed PUT-em. Lustro jest swieze wylacznie
// na moment ostatniego klikniecia „Odczytaj katalogi", a ten chodzi z przycisku.
//
// ⚠️⚠️ (5) DO ALLEGRO NIE PISZEMY NIC. Oferty wiaze sie recznie; API ofert w tej zmianie
// nie wystepuje.
import { wymagajListyKanalow } from './lista-kanalow.js';

// ——— JEDNOSTKI ——————————————————————————————————————————————————————————————
//
// ⚠️ `Map`, a nie literal obiektu: jednostka przychodzi ZE SKLEPU (cudze API), wiec wartosc
// „constructor" na literale oddalaby FUNKCJE zamiast `undefined`, a `??` by jej nie zlapal.
//
// ⚠️ WYLACZNIE METRYCZNE. `in` i `yd` WooCommerce zna, ale 70 cm to 27,5590551181… cala —
// do sklepu pojechalaby liczba zaokraglona, czyli INNY wymiar niz ten, ktory trzyma
// karta. Odmowa jest tu tansza niz cicha zaokraglona prawda.
const PRZELICZNIKI = new Map([['mm', 1], ['cm', 10], ['m', 1000]]);

const JEDNOSTKI_ZNANE = [...PRZELICZNIKI.keys()].join(', ');

/**
 * Milimetry → napis w jednostce sklepu.
 *
 * ⚠️ LICZYMY NA CALKOWITYCH, a nie przez dzielenie zmiennoprzecinkowe: `705 / 10` daje
 * w JS `70.5`, ale `1004 / 10` juz `100.39999999999999`, a taka liczba pojechalaby do sklepu
 * jako wymiar produktu. Reszta doklejana tekstem nie ma jak sie rozjechac.
 */
function wJednostce(mm, dzielnik) {
  const calosc = Math.trunc(mm / dzielnik);
  const reszta = mm % dzielnik;
  if (!reszta) return String(calosc);
  const cyfry = String(dzielnik).length - 1;
  return `${calosc}.${String(reszta).padStart(cyfry, '0').replace(/0+$/u, '')}`;
}

/**
 * Jednostka TEGO kanalu albo wyjatek.
 *
 * ⚠️ RZUCAMY, a nie oddajemy domyslne „cm". Ta funkcja jest wolana wylacznie dla kanalow,
 * ktorych jednostke wolajacy WLASNIE odczytal ze sklepu (`services/magazyn-zapis.js`:
 * `jednostkiSklepow`) — brak wpisu znaczy wiec usterke okablowania, a nie brak danych.
 * Kanal, ktorego jednostki nie udalo sie odczytac, jest odsiewany PRZED ta funkcja i wraca
 * na ekran z powodem.
 */
function jednostkaKanalu(jednostki, kanal) {
  const j = Object.hasOwn(jednostki ?? {}, kanal) ? jednostki[kanal] : null;
  const dzielnik = typeof j === 'string' ? PRZELICZNIKI.get(j) : undefined;
  if (!dzielnik) {
    throw new Error(`Nie znam jednostki wymiarów sklepu „${kanal}" (przyszło: `
      + `${JSON.stringify(j ?? null)}). Znam wyłącznie ${JEDNOSTKI_ZNANE} — nie zgaduję, `
      + 'bo pomyłka daje produkt 70 milimetrów zamiast 70 centymetrów.');
  }
  return { jednostka: j, dzielnik };
}

// ——— POROWNANIA —————————————————————————————————————————————————————————————

const napis = (x) => String(x ?? '').trim();

/**
 * ⚠️ POROWNANIE NUMEROW NIECZULE NA WIELKOSC LITER. Po stronie WooCommerce „PD10" i „pd10"
 * to jeden numer (porownanie w bazie sklepu nie jest czule), wiec wstrzymanie zapisu na samej
 * roznicy wielkosci liter zablokowaloby wymiary bez zadnego powodu. W druga strone: nasza
 * kolumna `karty.sku` ma `UNIQUE` typu BINARY i o tej roznicy nie wie — dlatego rozstrzyga
 * TO porownanie, a nie baza.
 */
const tenSamNumer = (a, b) => napis(a).toUpperCase() === napis(b).toUpperCase();

/**
 * Wymiar ze sklepu → porownywalna liczba. Woo oddaje wymiary NAPISEM („70", „70.0", "").
 * Napis pusty znaczy „sklep wymiaru nie ma", a nie zero.
 */
function liczbaWymiaru(x) {
  const s = napis(x);
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Czy wymiary w sklepie sa juz TE, ktore chcemy wyslac. Nieznane ≠ takie same. */
function wymiaryTeSame(wSklepie, nasze) {
  const dl = liczbaWymiaru(wSklepie?.length);
  const sz = liczbaWymiaru(wSklepie?.width);
  if (dl === null || sz === null) return false;
  // PRZ-090: glebokosc porownujemy tylko wtedy, gdy ja wysylamy — karta bez glebokosci nie dotyka `height`.
  if (Object.hasOwn(nasze, 'height') && liczbaWymiaru(wSklepie?.height) !== Number(nasze.height)) return false;
  return dl === Number(nasze.length) && sz === Number(nasze.width);
}

/**
 * Czy wolno wpisac NASZ numer produktowi, ktory w sklepie ma `wSklepie`.
 *
 * ⚠️⚠️ ROZSTRZYGNIECIE KONTROLERA, SPRAWDZANE TAKZE NA ZYWO. Scenariusz, przed ktorym to
 * broni: lustro z poniedzialku pokazuje puste SKU, we wtorek ktos wpisuje numer w WooCommerce,
 * w srode zapis widzi w lustrze pustke i nadpisuje TOZSAMOSC produktu. Dlatego `services/
 * magazyn-zapis.js` wola te sama funkcje jeszcze raz, na stanie odczytanym tuz przed PUT-em.
 */
export function czyWolnoNadpisac(naszSku, wSklepie) {
  const nasz = napis(naszSku);
  const ich = napis(wSklepie);
  // Bez naszego numeru nie ma czym nadpisac — to droga typowa dla kart przed przejeciem
  // numeru ze sklepu (`domain/przejecie-sku.js`).
  if (!nasz || !ich || tenSamNumer(nasz, ich)) return { wolno: true, powod: null };
  return {
    wolno: false,
    powod: `Produkt ma w sklepie numer „${ich}", a nasz rejestr mówi „${nasz}". Nie nadpisuję: `
      + 'numer w sklepie jest tożsamością produktu (adresy, eksporty, feed do Google), '
      + 'a takiego zapisu nie da się cofnąć z panelu. Najpierw przejmij numer ze sklepu albo '
      + 'popraw numer w sklepie.',
  };
}

// ——— SCIEZKA ————————————————————————————————————————————————————————————————
//
// ⚠️ WYLACZNIE CYFRY. `produkt_id` jest kolumna TEKSTOWA (bo identyfikator Allegro przychodzi
// napisem), wiec smiec w niej zamienilby `products/{id}` w zupelnie inny zasob REST-a —
// a zapis idzie metoda PUT. Ten sam warunek stoi drugi raz w `woo/client.js`, i ma stac:
// klient jest jedynym miejscem, ktore sklada adres HTTP.
const SAME_CYFRY = /^\d+$/u;

// ——— OPIS DLA CZLOWIEKA ——————————————————————————————————————————————————————

const opisWymiaru = (w, jednostka) => (w
  ? `${w.length} × ${w.width}${napis(w.height) ? ` × ${w.height}` : ''} ${jednostka}` : 'nieznane');

/**
 * Zdanie „co sie zmieni z czego na co" — jedyna rzecz, po ktorej czlowiek pozna, ze klika
 * to, co mysli. Zapisu nie da sie cofnac, wiec sama liczba pozycji nie wystarcza.
 */
function opisZmiany({ pola, skuWSklepie, naszSku, wymiaryWSklepie, jednostka }) {
  const czesci = [];
  if (Object.hasOwn(pola, 'sku')) {
    czesci.push(`SKU: ${napis(skuWSklepie) ? `„${napis(skuWSklepie)}"` : 'puste'} → „${pola.sku}"`);
  } else if (napis(naszSku)) {
    czesci.push(`SKU bez zmiany („${napis(naszSku)}")`);
  }
  if (Object.hasOwn(pola, 'dimensions')) {
    czesci.push(`wymiary: ${opisWymiaru(wymiaryWSklepie, jednostka)}`
      + ` → ${opisWymiaru(pola.dimensions, jednostka)}`);
  }
  return czesci.join('; ');
}

// ——— REGULA GLOWNA ——————————————————————————————————————————————————————————

/**
 * Co panel wysle do sklepow dla JEDNEJ karty — i czego nie wysle, oraz dlaczego.
 *
 * @param {object} karta wiersz `karty` (potrzebne: `id`, `nazwa`, `sku`, `szerokosc_mm`,
 *   `wysokosc_mm`)
 * @param {Array} produkty wiersze lustra `produkty_sklepowe` tej karty. Kazdy MOZE niesc
 *   `wymiary: { length, width, height }` — stan ZYWY, odczytany tuz przed zapisem. Kolumna lustra
 *   `wymiary_json` (PRZ-090) sluzy zakladaniu kart i NIE jest tu czytana: przy podgladzie tego pola
 *   po prostu nie ma i wymiary licza sie jako zmiana.
 * @param {Record<string, string>} jednostki kanal → jednostka wymiarow sklepu
 * @returns {{ zmiany: Array, wstrzymane: Array<{karta_id, kanal, produkt_id, wariant_id, nazwa, powod}> }}
 *
 * ⚠️ JEDNA FUNKCJA LICZY OBA ZBIORY. Osobna funkcja „co wstrzymane" musialaby powtorzyc caly
 * ten przebieg i rozjechalaby sie z nim przy pierwszej zmianie reguly — a wtedy ekran
 * pokazywalby jedno, a zapis robil drugie.
 */
export function ocenZapis(karta, produkty, jednostki, kanalySklepow) {
  wymagajListyKanalow(kanalySklepow);
  const zmiany = [];
  const wstrzymane = [];
  const naszSku = napis(karta?.sku);
  // ⚠️ POLOWA WYMIARU TO NIE WYMIAR: wyslanie samej szerokosci zostawiloby w sklepie wysokosc
  // z poprzedniej wartosci, czyli produkt, ktorego nigdzie nie ma. Zero jest brakiem, nie
  // wymiarem — kolumna jest w milimetrach i produkt o boku 0 nie istnieje.
  const szer = Number(karta?.szerokosc_mm) > 0 ? Number(karta.szerokosc_mm) : null;
  const wys = Number(karta?.wysokosc_mm) > 0 ? Number(karta.wysokosc_mm) : null;
  // PRZ-090: glebokosc (Woo `height`) jest opcjonalna i jedzie tylko razem z para wyzej.
  const gl = Number(karta?.glebokosc_mm) > 0 ? Number(karta.glebokosc_mm) : null;

  for (const p of produkty ?? []) {
    const wspolne = {
      karta_id: karta?.id ?? null,
      kanal: p?.kanal,
      produkt_id: napis(p?.produkt_id),
      wariant_id: napis(p?.wariant_id),
      nazwa: p?.nazwa ?? null,
    };
    const wstrzymaj = (powod) => wstrzymane.push({ ...wspolne, powod });

    // ⚠️ DO ALLEGRO NIE PISZEMY NIC — i to nie jest pozycja „wstrzymana". Oferta Allegro nie
    // jest produktem WooCommerce; jej obecnosc przy karcie jest normalna i nie ma o czym
    // meldowac. Zbior „wstrzymane" jest lista PROBLEMOW i ma zostac krotka.
    if (!kanalySklepow.includes(p?.kanal)) continue;

    // ⚠️ PRODUKT ZNIKNIETY ZE SKLEPU. Wiersz zostaje w lustrze (powiazanie ma przezyc
    // wycofanie ze sprzedazy), ale PUT poszedlby albo w nieistniejacy zasob, albo w produkt,
    // ktorego sklep juz nie sprzedaje.
    if (napis(p?.zniknal_at)) {
      wstrzymaj('Produkt zniknął ze sklepu przy ostatnim odczycie katalogów — nie piszę do '
        + 'czegoś, czego sklep już nie pokazuje. Odczytaj katalogi jeszcze raz.');
      continue;
    }

    if (!SAME_CYFRY.test(wspolne.produkt_id)
      || (wspolne.wariant_id && !SAME_CYFRY.test(wspolne.wariant_id))) {
      wstrzymaj(`Identyfikator produktu w sklepie („${wspolne.produkt_id}"`
        + `${wspolne.wariant_id ? `, wariant „${wspolne.wariant_id}"` : ''}) nie jest liczbą, `
        + 'więc nie złożę z niego adresu zapisu. To wygląda na uszkodzony wiersz lustra.');
      continue;
    }

    const wolno = czyWolnoNadpisac(naszSku, p?.sku_sklepu);
    // ⚠️ WSTRZYMANIE JEST CALOSCIOWE — bez wymiarow. Produkt, ktorego numeru nie rozpoznajemy,
    // moze byc CUDZY, a wtedy zmiana jego wymiarow jest zmiana w cudzym produkcie.
    if (!wolno.wolno) {
      wstrzymaj(wolno.powod);
      continue;
    }

    // Jednostka pytana DOPIERO TERAZ: pozycja wstrzymana wczesniej nie ma czego przeliczac,
    // a wyjatek o jednostce zaslonilby prawdziwy powod wstrzymania.
    const { jednostka, dzielnik } = jednostkaKanalu(jednostki, p.kanal);

    const pola = {};
    // Numer jedzie WYLACZNIE wtedy, gdy sklep ma inny (albo zaden). Ten sam numer wyslany
    // jeszcze raz to zadanie do sklepu po nic — a przy 1459 produktach to godziny.
    if (naszSku && !tenSamNumer(naszSku, p?.sku_sklepu)) pola.sku = naszSku;

    let wymiaryNasze = null;
    if (szer && wys) {
      // ⚠️ `length` to WYSOKOSC produktu, `width` to SZEROKOSC — kolejnosc jak w sklepie,
      // nie jak w nazwie kolumny. Zamiana miejscami obraca produkt o 90° i psuje pakowanie.
      wymiaryNasze = { length: wJednostce(wys, dzielnik), width: wJednostce(szer, dzielnik) };
      if (gl) wymiaryNasze.height = wJednostce(gl, dzielnik);
      // ⚠️ WYMIARY NIEZNANE (lustro ich nie trzyma) NIE SA „takie same". Podglad ma pokazac
      // je jako jadace — inaczej obiecywalby, ze nic sie nie zmieni, a zapis i tak by je wyslal.
      if (!wymiaryTeSame(p?.wymiary, wymiaryNasze)) pola.dimensions = wymiaryNasze;
    }

    // Nic do wyslania to NIE JEST problem — to produkt, ktory juz ma to, co ma miec.
    if (!Object.keys(pola).length) continue;

    zmiany.push({
      ...wspolne,
      // ⚠️⚠️ SCIEZKA ROZSTRZYGA RODZIC vs WARIANT — patrz naglowek pliku.
      sciezka: wspolne.wariant_id
        ? `products/${wspolne.produkt_id}/variations/${wspolne.wariant_id}`
        : `products/${wspolne.produkt_id}`,
      pola,
      opis: opisZmiany({
        pola, skuWSklepie: p?.sku_sklepu, naszSku, wymiaryWSklepie: p?.wymiary, jednostka,
      }),
    });
  }

  return { zmiany, wstrzymane };
}

/**
 * Sama lista zmian do wyslania — ta sama regula, co `ocenZapis`, bez powodow wstrzymania.
 * Interfejs z planu (Zadanie 14); wolaja go testy i te miejsca, ktorych powody nie obchodza.
 */
export function zmianyDoWyslania(karta, produkty, jednostki, kanalySklepow) {
  return ocenZapis(karta, produkty, jednostki, kanalySklepow).zmiany;
}
