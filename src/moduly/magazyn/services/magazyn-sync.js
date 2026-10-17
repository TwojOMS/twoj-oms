// Przebieg odczytu katalogow do lustra magazynu (`produkty_sklepowe`) — spinacz czterech
// kanalow: dwa sklepy WooCommerce i dwa konta Allegro.
//
// ⚠️⚠️ NAJWAZNIEJSZY NIEZMIENNIK TEGO PLIKU: KANAL, KTORY PADL, NIE DOCHODZI DO
// `oznaczZnikniete`. Ta funkcja stempluje `zniknal_at` wszystkiemu, czego biezacy przebieg
// nie zobaczyl — wiec wywolana po nieudanym odczycie oznaczylaby CALY katalog kanalu jako
// wycofany ze sprzedazy. Sklep, ktory na chwile odmowil, wygladalby na sklep, ktory stracil
// tysiac produktow. Awaria jednego kanalu nie ma tez prawa zatrzymac pozostalych trzech
// (ta sama zasada, co w zbiorczym przebiegu pollera, bootstrap.js).
//
// ⚠️ KLIENTOW ALLEGRO TEN MODUL NIE TWORZY I TWORZYC NIE MOZE. Dostaje MAPE kanal → klient,
// zbudowana raz w `bootstrap.js` (`klienciKanalow`). Druga instancja klienta na ten sam kanal
// to druga para tokenow w pamieci procesu i DWA niezalezne odswiezenia tego samego refresh
// tokenu — a te sa JEDNORAZOWE. Spalenie jednego rozwala pollera zamowien i nadawanie paczek
// przez „Wysylam z Allegro", oba na produkcji.
//
// ⚠️ DWIE FAZY NA KANAL, W TEJ KOLEJNOSCI I NIE ODWROTNIE:
//   (1) ODCZYT I MAPOWANIE — siec, `await`, wolno rzucic;
//   (2) ZAPIS — synchronicznie, w JEDNEJ transakcji, razem z `oznaczZnikniete`.
// Rozdzielenie ich jest tresciowe, nie porzadkowe. Po pierwsze, kanal przerwany w polowie
// nie zostawia polowy katalogu z nowym `odczytane_at` (a druga polowa wygladalaby przy
// nastepnym przebiegu jak znikniety towar). Po drugie, transakcja NIE OBEJMUJE ANI JEDNEGO
// `await` — baza OMS-u stoi na jednym polaczeniu wspoldzielonym z pollerem, wiec transakcja
// rozciagnieta na odczyt HTTP (minuty) wciagnelaby do siebie zapisy pollera i cofnela je
// wlasnym ROLLBACK-iem. Faza zapisu jest w calosci synchroniczna, wiec petla zdarzen nie ma
// jak wejsc w srodek.
import { zapiszProduktSklepowy, oznaczZnikniete, liczZyweProdukty } from '../../../oms/db/magazyn.js';
import { ofertaNaProdukt } from '../../../domena/allegro-oferta.js';
import { wymagajListyKanalow } from '../../../domena/lista-kanalow.js';
import { atrybutyZWariantu } from '../../../domena/atrybuty-wariantu.js';
import { groszeZKwoty } from '../../../domena/kwota.js';

// ⚠️ BIALA LISTA, nie „jakis niepusty napis". `zapiszProduktSklepowy` sprawdza wylacznie, czy
// kanal jest niepusty, wiec literowka w kluczu konfiguracji zalozylaby kanal WIDMOWY: wiersze,
// ktorych nie pokaze zaden filtr listy, i ktorych `oznaczZnikniete` nigdy nie posprzata.
// Wartosci sa TE SAME, co klucze `config.sklepy` i kolumna `zamowienia.sklep`.
//
// Rozdzial na sklepy i kanaly Allegro jest CZESCIA ochrony: sklep podpiety pod klucz konta
// Allegro wpisalby produkty Woo do katalogu Allegro, a najblizszy przebieg tamtego konta
// oznaczylby cala te wtrete jako znikniete.
//
// Obie listy przekazuje moduł z konfiguracji instancji. Te same klucze sklepów
// otrzymuje domena kart; domena nie importuje przebiegu odczytu.

// Metadana Yoasta z kategoria glowna. Nazwa jest „chroniona" (podkreslnik), ale WooCommerce
// REST v3 i tak ja oddaje — ta sama wlasciwosc, na ktorej stoi rozpoznanie zamowien
// indywidualnych (`_zam_offer_id`). Wartosc przychodzi NAPISEM, nie liczba.
const YOAST_KATEGORIA = '_yoast_wpseo_primary_product_cat';

// Atrybut niosacy rozmiar. Porownanie DOKLADNE (po znormalizowaniu wielkosci liter), a nie
// „zawiera": atrybut „Rozmiar klosza" i „Rozmiar" moglyby znaczyc co innego, a magazyn trzyma
// wymiar CALEGO produktu (ten, z ktorego powstaje paczka).
const ATRYBUT_ROZMIARU = 'rozmiar';

// Ten sam warunek, co w domain/miniatury.js i domain/allegro-oferta.js, i z tego samego
// powodu: adres laduje wprost w atrybucie `src` naszego HTML-a.
const ADRES_HTTP = /^https?:\/\//i;

const pusteNaNull = (x) => (typeof x === 'string' && x.trim() ? x : null);

/**
 * Znacznik odczytu — ZAWSZE przez `toISOString()`, i to jest granica, na ktorej to wymuszamy.
 *
 * ⚠️ `odczytane_at` jest porownywane LEKSYKOGRAFICZNIE (`odczytane_at < ?` w `oznaczZnikniete`),
 * bo SQLite nie ma typu daty. Jeden „+02:00" zamiast „Z" i porownanie zaczyna klamac: zapisane
 * „2026-08-06T12:00:00+02:00" wyglada dla SQLite na PÓŹNIEJSZE niz „2026-08-06T11:00:00Z", choc
 * jest o godzine wczesniejsze — czyli przebieg albo nie oznaczy nic, albo oznaczy zywy katalog.
 *
 * Smiec zamiast chwili wywala przebieg PRZED pierwszym zapytaniem do sklepu: „Invalid Date"
 * w kolumnie znaczylby, ze `oznaczZnikniete` nie oznaczy juz nigdy niczego.
 */
function znacznik(teraz) {
  const surowy = typeof teraz === 'function' ? teraz() : teraz;
  const chwila = new Date(surowy);
  if (Number.isNaN(chwila.getTime())) {
    throw new Error(
      `odswiezMagazyn: „${String(surowy)}" nie jest chwilą, z której da się zrobić znacznik odczytu`,
    );
  }
  return chwila.toISOString();
}

// Kolumna `nazwa` jest NOT NULL, a nazwa to JEDYNA rzecz, po ktorej czlowiek wiaze wiersz
// z kartą. Bez tego straznika brak nazwy wychodzi dopiero na bazie, w polowie 668 produktow,
// i mowi „NOT NULL constraint failed" zamiast wskazac produkt.
function nazwaProduktu(kanal, produkt) {
  const nazwa = produkt?.name;
  if (typeof nazwa !== 'string' || !nazwa.trim()) {
    throw new Error(`Sklep ${kanal}: produkt ${produkt?.id ?? '(bez identyfikatora)'} nie ma nazwy`);
  }
  return nazwa;
}

/**
 * Cena ze sklepu → grosze.
 *
 * ⚠️ WOO ODDAJE CENE NAPISEM, a `produkty_sklepowe.cena_gr` jest `INTEGER`. Napis w tej kolumnie
 * psuje filtr ceny w CALYM magazynie (porownanie napisu z liczba w SQLite jest zawsze falszywe),
 * wiec kwota, ktorej nie umiemy przeliczyc, ma wywalic kanal — glosno.
 *
 * Pusty napis to co innego niz smiec: produkt bez ceny jest w Woo normalny (rodzic wariantowego,
 * produkt w przygotowaniu) i daje `null`. `null` znaczy „nie wiem", zero znaczyloby „za darmo"
 * i wpadalo w kazdy filtr ceny od zera w gore.
 */
function cenaGr(surowa, opis) {
  if (typeof surowa === 'string' && !surowa.trim()) return null;
  return groszeZKwoty(surowa, opis);
}

const kategorieProduktu = (p) => (Array.isArray(p?.categories) ? p.categories : []);

// Kategorie jako tablica NAZW — z niej korzysta filtr kategorii listy (json_each po tej
// kolumnie) i tworzenie kart (Zadanie 8).
const kategorieJson = (p) => JSON.stringify(
  kategorieProduktu(p).map((k) => k?.name).filter((n) => typeof n === 'string' && n.trim()),
);

/**
 * Kategoria glowna TAK, JAK ZNA JA SKLEP (Yoast).
 *
 * ⚠️ MAPUJEMY IDENTYFIKATOR NA NAZWE Z KATEGORII TEGO SAMEGO PRODUKTU, a nie osobnym
 * zapytaniem do `/products/categories`. Produkt niesie komplet `{ id, name }` w tej samej
 * odpowiedzi, wiec dodatkowy odczyt bylby dwoma zadaniami HTTP i druga lista do rozjechania.
 *
 * ⚠️ SUROWY IDENTYFIKATOR W KOLUMNIE NAZWY JEST GORSZY NIZ BRAK: Zadanie 8 przepisuje te
 * wartosc do `karty.kategoria_glowna`, a z niej korzysta generator SKU — „64" zamiast
 * „Lampy stołowe" produkowaloby numery katalogowe z niczego. Identyfikator, ktorego nie ma
 * wsrod kategorii produktu, daje wiec `null`, a nie siebie samego.
 */
function kategoriaGlownaZrodla(produkt) {
  const meta = Array.isArray(produkt?.meta_data) ? produkt.meta_data : [];
  const wartosc = meta.find((m) => m?.key === YOAST_KATEGORIA)?.value;
  const id = wartosc === null || wartosc === undefined ? '' : String(wartosc).trim();
  if (!id) return null;
  const nazwa = kategorieProduktu(produkt).find((k) => String(k?.id) === id)?.name;
  return typeof nazwa === 'string' && nazwa.trim() ? nazwa : null;
}

// Adresy zdjec w kolejnosci ze sklepu; pierwszy jest glowny. Tablica, a nie goly adres —
// kolumna jest wspolna z ofertami Allegro, gdzie element jest jeden.
function zdjeciaJson(adresy) {
  const dobre = [];
  for (const a of adresy) {
    if (typeof a !== 'string') continue;
    const adres = a.trim();
    if (!adres || !ADRES_HTTP.test(adres) || dobre.includes(adres)) continue;
    dobre.push(adres);
  }
  // Brak zdjec to `null`, nie „[]" — pusta tablica twierdzilaby, ze zdjecia sprawdzilismy
  // i ich nie ma, a widok i tak musi obsluzyc oba przypadki tak samo.
  return dobre.length ? JSON.stringify(dobre) : null;
}

const zdjeciaProduktu = (p) => (Array.isArray(p?.images) ? p.images : []).map((z) => z?.src);

/**
 * Rozmiar z atrybutow. Wariant niesie `option` (jedna wartosc), produkt prosty `options` (lista).
 *
 * ⚠️ ATRYBUT WYGRYWA NAD NAZWA I TO JEST REGULA NOSNA, NIE PORZADKOWA. Na sklepie B oba niosa ROZNE,
 * PRAWDZIWE liczby: „Lampa wisząca Kopuła – 30x45cm" ma atrybut „40 x 60 cm", bo 30×45 to sam KLOSZ,
 * a 40×60 to caly produkt z oprawa. Magazyn trzyma wymiar z ATRYBUTU — to on decyduje
 * o pakowaniu, paczkomacie i cenie. Odwrocenie kolejnosci zepsuloby kolumne paczkomatu na calym sklepie B.
 *
 * Kilka wartosci w `options` sklejamy przecinkiem zamiast wybierac jedna: `wymiaryZTekstu` odda
 * wtedy `null` (dwa trafienia = niejednoznacznosc), czyli brak — a nie zgadniety rozmiar.
 */
function rozmiarZAtrybutow(atrybuty) {
  if (!Array.isArray(atrybuty)) return null;
  for (const a of atrybuty) {
    if (String(a?.name ?? '').trim().toLowerCase() !== ATRYBUT_ROZMIARU) continue;
    const wartosc = a?.option ?? (Array.isArray(a?.options) ? a.options.join(', ') : null);
    if (typeof wartosc === 'string' && wartosc.trim()) return wartosc.trim();
  }
  return null;
}

/**
 * MINIATURA GLOWNEGO ZDJECIA — z mapy przyniesionej ze Store API sklepu.
 *
 * ⚠️⚠️ TU KONCZY SIE ZGADYWANIE. Do 2026-08-12 lustro trzymalo wylacznie adresy ORYGINALOW,
 * a widok listy doklejal `-150x150` do nazwy pliku (`domain/miniatury.js: adresMiniatury`).
 * Zmierzone na wszystkich adresach: sklep B 103/103 trafien, sklep A 76/684
 * — 608 razy 404 (89%), bo TEN sklep skaluje miniatury do 247x296. Store API oddaje gotowy
 * adres przy kazdym zdjeciu, wiec zgadywac nie ma juz po co ani czego.
 *
 * ⚠️ CZEGO NIE ZNAMY, TEGO NIE WPISUJEMY: `null`, nigdy adres zgadniety ani oryginal.
 * Pusta komorka jest dzis i tak stanem widocznym, a 608 oryginalow po ~250 kB to ponad
 * 150 MB na JEDNEJ stronie listy.
 */
const miniaturaZMapy = (miniatury, produktId) => miniatury.get(String(produktId ?? '')) ?? null;

/**
 * PRZ-090 — wymiary i waga, ktore sklep podaje sam, z JEDNOSTKA sklepu (bez niej liczba nic nie znaczy).
 * `wymiary_json` = `{ length, width, height, unit }` albo `null`, gdy sklep nie podal ani jednej liczby
 * albo jednostki nie znamy; `waga_tekst` = „1.25 kg” albo `null`. Odczyt robi domena/rozmiar.js.
 * ⚠️ WARIANT NIE DZIEDZICZY WYMIAROW ANI WAGI PO RODZICU (poprawka po recenzji PRZ-090). Warianty jednego produktu
 * roznia sie zwykle wlasnie rozmiarem — wymiar rodzica podstawiony kazdemu z nich dalby kilku kartom ten sam wymiar.
 * Ta sama zasada, co przy rozmiarze wariantu z atrybutu (`wierszWariantu`): brak jest uczciwsza odpowiedzia.
 */
function wymiaryLustra(zrodlo, jednostki) {
  const d = zrodlo?.dimensions ?? {};
  const wartosc = (k) => pusteNaNull(d?.[k]);
  const w = { length: wartosc('length'), width: wartosc('width'), height: wartosc('height') };
  const wymiary = jednostki?.wymiary && (w.length || w.width || w.height)
    ? JSON.stringify({ ...w, unit: jednostki.wymiary }) : null;
  const waga = pusteNaNull(zrodlo?.weight);
  return { wymiary_json: wymiary, waga_tekst: waga && jednostki?.waga ? `${waga} ${jednostki.waga}` : null };
}

/**
 * Jednostki wymiarow i wagi sklepu. ⚠️ Awaria (albo klient bez `ustawienieSklepu`) NIE wywraca odczytu —
 * wymiary i waga sa dodatkiem do lustra, a bez jednostki po prostu ich nie zapisujemy.
 */
async function jednostkiKanalu({ kanal, klient, zapisz }) {
  if (typeof klient?.ustawienieSklepu !== 'function') return { wymiary: null, waga: null };
  const odczytaj = async (id) => {
    try {
      const j = await klient.ustawienieSklepu(id);
      return typeof j === 'string' && j.trim() ? j.trim() : null;
    } catch (e) {
      zapisz(`magazyn: kanał ${kanal} — nie udało się odczytać ustawienia ${id} (wymiary i waga bez niego):`, opisBledu(e));
      return null;
    }
  };
  return { wymiary: await odczytaj('woocommerce_dimension_unit'), waga: await odczytaj('woocommerce_weight_unit') };
}

function wierszProduktu(kanal, p, odczytaneAt, miniatury, jednostki) {
  const nazwa = nazwaProduktu(kanal, p);
  return {
    kanal,
    produkt_id: p?.id,
    miniatura: miniaturaZMapy(miniatury, p?.id),
    // Pusty napis, nie `null`: w SQLite NULL-e w UNIQUE sa wzajemnie ROZNE, wiec przy `null`
    // ten sam produkt prosty wpadalby do tabeli przy KAZDYM przebiegu odczytu.
    wariant_id: '',
    nazwa,
    sku_sklepu: pusteNaNull(p?.sku),
    cena_gr: cenaGr(p?.price, `kanał ${kanal}, produkt ${p?.id}`),
    kategorie_json: kategorieJson(p),
    zdjecia_json: zdjeciaJson(zdjeciaProduktu(p)),
    adres: pusteNaNull(p?.permalink),
    // Produkt prosty nie ma wariantow, wiec gdy atrybutu nie ma, jedynym zrodlem rozmiaru
    // jest nazwa („Chmurka i Księżyc – aplikacja 30x48cm").
    rozmiar_tekst: rozmiarZAtrybutow(p?.attributes) ?? nazwa,
    kategoria_glowna_zrodla: kategoriaGlownaZrodla(p),
    opis_zrodlowy: pusteNaNull(p?.short_description),
    ...wymiaryLustra(p, jednostki),
    // Sklepy pobieramy WYLACZNIE ze `status=publish`, wiec stanu publikacji nie ma czym
    // wypelnic — ta kolumna nalezy do Allegro (ACTIVE/ENDED).
    status_publikacji: null,
    odczytane_at: odczytaneAt,
  };
}

/**
 * Wiersz z WARIANTU. SKU i cena zyja na wariancie, nazwa i kategorie na rodzicu — zmierzone:
 * rodzic „Lampa wisząca Kopuła" ma SKU puste i cene jako zakres 49–74,90, a warianty `B-KOP-117` / `B-KOP-118`
 * i ceny 49 / 74,90. Dlatego jeden wiersz magazynu = jeden wariant, nie jeden produkt.
 *
 * ⚠️⚠️ ROZMIAR WARIANTU BIERZE SIE WYLACZNIE Z JEGO ATRYBUTU I NIGDY Z NAZWY RODZICA.
 * Szesc produktow wariantowych na sklepie A jest zepsutych w sklepie: warianty roznia sie
 * WYLACZNIE cena (79/99/119 zl) i nie niosa zadnego atrybutu rozmiaru. Podstawienie tam nazwy
 * rodzica daloby TRZEM roznym rozmiarom ten sam wymiar — a z niego powstaje paczka, gabaryt
 * i wymiar w sklepie. Brak jest tu jedyna uczciwa odpowiedzia; Zadanie 8 rozpoznaje
 * takie warianty wlasnie po pustym `rozmiar_tekst` i nie tworzy z nich kart.
 */
function wierszWariantu(kanal, rodzic, wariant, odczytaneAt, miniatury, jednostki) {
  const nazwa = nazwaProduktu(kanal, rodzic);
  // Wariant bez identyfikatora zapisalby sie z `wariant_id = ''`, czyli PODSZYLBY SIE pod
  // wiersz produktu prostego o tym samym `produkt_id` — a dwa takie warianty nadpisywalyby
  // ten jeden wiersz na okraglo, przy kazdym przebiegu.
  if (wariant?.id === null || wariant?.id === undefined || wariant.id === '') {
    throw new Error(`Sklep ${kanal}: wariant produktu ${rodzic?.id} nie ma identyfikatora`);
  }
  return {
    kanal,
    produkt_id: rodzic?.id,
    wariant_id: wariant.id,
    // ⚠️ MINIATURA RODZICA, I TO JEST SWIADOME. Store API oddaje zdjecia na PRODUKCIE,
    // a warianty jako samo `{ id, attributes }` — wlasnego zdjecia w tej odpowiedzi nie ma
    // skad wziac. Nie jest to jednak proteza: wariant zwykle wlasnego zdjecia nie ma, a gdy
    // ma, galeria i tak zaczyna sie od zdjecia rodzica. Klucz to identyfikator RODZICA;
    // pytanie mapy o identyfikator wariantu nie trafiloby NIGDY w zaden wpis, cicho.
    miniatura: miniaturaZMapy(miniatury, rodzic?.id),
    nazwa,
    sku_sklepu: pusteNaNull(wariant?.sku),
    cena_gr: cenaGr(wariant?.price, `kanał ${kanal}, produkt ${rodzic?.id}, wariant ${wariant.id}`),
    kategorie_json: kategorieJson(rodzic),
    // Wlasne zdjecie wariantu jest najbardziej szczegolowe, wiec idzie pierwsze — ale galeria
    // rodzica nie ma prawa przez to zginac: to z niej powstaje galeria karty.
    zdjecia_json: zdjeciaJson([wariant?.image?.src, ...zdjeciaProduktu(rodzic)]),
    adres: pusteNaNull(wariant?.permalink) ?? pusteNaNull(rodzic?.permalink),
    rozmiar_tekst: rozmiarZAtrybutow(wariant?.attributes),
    // ⚠️ OSIE PODZIALU WARIANTU — to po nich `domain/karta-z-produktu.js` rozstrzyga, czy
    // wariant bez rozmiaru jest OSOBNĄ KARTĄ („Kinkiet Ramię — Mosiądz"), czy usterka sklepu.
    // Zapisujemy je TUTAJ, przy wariancie, i nigdzie indziej: `wierszProduktu` (produkt prosty)
    // zostawia te kolumne pusta, bo produkt bez wariantow nie ma czego dzielic, a dopisanie
    // mu atrybutow kazaloby dokleic ich wartosci do nazw ~588 prostych produktow sklepu A.
    atrybuty_json: JSON.stringify(atrybutyZWariantu(wariant)),
    kategoria_glowna_zrodla: kategoriaGlownaZrodla(rodzic),
    opis_zrodlowy: pusteNaNull(rodzic?.short_description),
    ...wymiaryLustra(wariant, jednostki),
    status_publikacji: null,
    odczytane_at: odczytaneAt,
  };
}

/**
 * Mapa `id produktu` → adres miniatury, ze Store API sklepu.
 *
 * ⚠️⚠️ AWARIA STORE API NIE MA PRAWA WYWROCIC ODCZYTU KATALOGOW, i to jest cala tresc tej
 * funkcji. To ta sama zasada, co przy izolacji awarii kanalu wyzej: kanal, ktory rzucil,
 * NIE DOCHODZI do `oznaczZnikniete` — czyli awaria OZDOBY (miniatur) oznaczylaby caly katalog
 * sklepu jako wycofany ze sprzedazy. Odczyt ma sie udac, a miniatury zostac NIEZNANE.
 *
 * ⚠️ SLAD W LOGU JEST TU CZESCIA OCHRONY, nie dodatkiem — dokladnie jak przy bledzie kanalu.
 * Miniatury, ktore po cichu przestaly przychodzic (wtyczka wylaczyla Store API, WAF zaczal
 * oddawac HTML), wygladaja na ekranie IDENTYCZNIE jak sklep bez zdjec.
 *
 * ⚠️ `pobierzMiniatury?.()` z pytajnikiem: klient bez tej metody (starsza atrapa, klient
 * zlozony gdzie indziej) ma dac odczyt BEZ miniatur, a nie wyjatek — i bez wpisu w logu,
 * bo to nie jest awaria, tylko brak funkcji.
 */
async function miniaturyKanalu({ kanal, klient, zapisz }) {
  try {
    const mapa = await klient?.pobierzMiniatury?.();
    return mapa instanceof Map ? mapa : new Map();
  } catch (e) {
    zapisz(`magazyn: kanał ${kanal} — nie udało się odczytać miniatur ze Store API `
      + '(katalog wchodzi bez nich):', opisBledu(e));
    return new Map();
  }
}

// FAZA 1 dla sklepu: odczyt i mapowanie. Nic tu nie dotyka bazy.
async function wierszeSklepu({ kanal, klient, odczytaneAt, zglos, zapisz }) {
  const produkty = await klient.pobierzWszystkieProdukty();
  // ⚠️ PO katalogu, a nie przed nim: sklep, ktory odmowil katalogu, nie ma po co byc pytany
  // o ozdobe — a przebieg i tak konczy sie wtedy bledem kanalu.
  const miniatury = await miniaturyKanalu({ kanal, klient, zapisz });
  const jednostki = await jednostkiKanalu({ kanal, klient, zapisz });
  const wiersze = [];
  let zrobione = 0;
  for (const p of produkty) {
    // ⚠️ WARIANTY WOLAMY WYLACZNIE DLA `type: 'variable'`. Warianty NIE WYCHODZA z `/products`,
    // wiec lustro zbudowane z samej listy produktow nie zobaczyloby ANI JEDNEGO SKU wariantu,
    // czyli glownego celu magazynu. W druga strone: pytanie o warianty kazdego produktu to
    // 668 zadan HTTP po nic.
    if (p?.type === 'variable') {
      for (const w of await klient.pobierzWarianty(p?.id)) {
        wiersze.push(wierszWariantu(kanal, p, w, odczytaneAt, miniatury, jednostki));
      }
    } else {
      wiersze.push(wierszProduktu(kanal, p, odczytaneAt, miniatury, jednostki));
    }
    zrobione += 1;
    zglos({ kanal, zrobione, zTego: produkty.length });
  }
  return wiersze;
}

// FAZA 1 dla Allegro.
//
// ⚠️ `pobierzOferty()` JEST BEZ ARGUMENTU — klient jest juz per-konto. Kanal dokleja WOLAJACY,
// z klucza mapy, i sprawdza go biala lista w `domain/allegro-oferta.js`. Rozlozenie tego na
// `{ kanal, ...ofertaNaProdukt(o) }` RZUCA: `ofertaNaProdukt` wymaga kanalu jako argumentu.
async function wierszeAllegro({ kanal, klient, odczytaneAt, zglos, kanalyAllegro }) {
  const oferty = await klient.pobierzOferty();
  const wiersze = [];
  let zrobione = 0;
  for (const o of oferty) {
    // ⚠️ MINIATURE OFERTY WYLICZA `ofertaNaProdukt` — patrz komentarz przy niej. Allegro nie
    // ma Store API, wiec jest to jedyny kanal, w ktorym adres miniatury nadal WYPROWADZAMY;
    // robi to jednak PODMIANA SEGMENTU SCIEZKI, zmierzona na zywych zdjeciach, a nie
    // doklejanie rozmiaru do nazwy pliku, ktore wlasnie wyrzucamy ze sklepow.
    wiersze.push({ ...ofertaNaProdukt(o, kanal, kanalyAllegro), odczytane_at: odczytaneAt });
    zrobione += 1;
    zglos({ kanal, zrobione, zTego: oferty.length });
  }
  return wiersze;
}

/**
 * FAZA 2: zapis kanalu. Synchronicznie i w JEDNEJ transakcji — razem z `oznaczZnikniete`.
 *
 * ⚠️ `oznaczZnikniete` STOI PO WSZYSTKICH ZAPISACH i to jest tresc, nie kolejnosc dla porzadku.
 * Przeniesione przed nie zmienia stanu koncowego (upsert zeruje `zniknal_at`), ale licznik
 * zaczyna mowic „zniknelo 668 produktow" przy sklepie, w ktorym nie zniknelo nic — a ten
 * licznik jest jedynym sygnalem, po ktorym czlowiek zauwaza, ze sklep sie sypie.
 *
 * ⚠️ Zmierzone (3000 wierszy, baza na dysku): w autocommicie 3,7 s, w transakcji 222 ms —
 * kazdy `run()` to osobna transakcja WAL z wlasnym fsync. To ta sama lekcja, ktora opisuje
 * przeliczenie wsteczne w `db/db.js`.
 */
function zapiszKanal(db, kanal, wiersze, odczytaneAt) {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const w of wiersze) zapiszProduktSklepowy(db, w);
    const znikniete = oznaczZnikniete(db, kanal, odczytaneAt);
    db.exec('COMMIT');
    return { zapisane: wiersze.length, znikniete };
  } catch (e) {
    // Przerwany zapis ma zostawic lustro w stanie SPRZED przebiegu, a nie w polowie.
    db.exec('ROLLBACK');
    throw e;
  }
}

// Blad rzucony jako napis (albo `null`) tez musi dac sie przeczytac: ten komunikat laduje
// na ekranie przy kanale, a „undefined" nie mowi nic.
const opisBledu = (e) => (typeof e?.message === 'string' && e.message ? e.message : String(e));

/**
 * HAMULEC: odczyt oddal ZERO pozycji, a lustro trzyma dla tego kanalu zywe wiersze.
 *
 * ⚠️⚠️ ZMIERZONE NA PRAWDZIWEJ BAZIE: 668 produktow w lustrze, klient oddaje `[]`, przebieg
 * konczy sie `{ zapisane: 0, znikniete: 668, blad: null }` — MELDUJE SUKCES, a magazyn pokazuje
 * pusty kanal. Sklep odmawia bowiem KODEM 200 (konflikt wtyczki, tryb konserwacji, nieudany
 * import masowy), wiec klient nie ma czego zglosic: tablica jest tablica, a kontrola
 * kompletnosci przy `totalCount = 0` jest swiadomie pomijana. Cichy pusty odczyt i cichy blad
 * kanalu daja na ekranie IDENTYCZNY obraz — lustro wygladajace jak sklep bez zmian.
 *
 * ⚠️ RZUCAMY, i to jest cala konstrukcja tego hamulca: wchodzi on na ISTNIEJACA sciezke bledu
 * kanalu, wiec transakcja sie nie zaczyna, `oznaczZnikniete` nie ma jak sie wykonac, a pozostale
 * kanaly jada dalej. Druga, rownolegla sciezka obslugi musialaby powtorzyc te trzy wlasnosci
 * i rozjechalaby sie z oryginalem.
 *
 * ⚠️ TYLKO ZERO, NIGDY „mniej, niz bylo". Wlasciciel wycofujacy jedna pozycje ma dostac
 * normalne zniknięcie; straznik na „odczyt mniejszy niz lustro" uniemozliwilby wycofanie
 * czegokolwiek ze sprzedazy.
 *
 * ⚠️ PRZYJETY KOSZT, SWIADOMIE (decyzja wlasciciela): przy PRAWDZIWYM wygaszeniu sprzedazy na
 * kanale magazyn bedzie go pokazywal az do recznej interwencji (wystarczy oznaczyc wiersze
 * kanalu jako zniknięte — patrz `liczZyweProdukty`). Wariant z przyciskiem „tak, naprawde
 * pusty" zostal ODRZUCONY jako niewart osobnego ekranu. To nie jest uciazliwosc do naprawienia:
 * cena za pomylke w druga strone to zniknieciecie calego katalogu z widoku.
 */
function sprawdzPustyOdczyt(db, kanal, ilePozycji) {
  if (ilePozycji > 0) return;
  const zywe = liczZyweProdukty(db, kanal);
  if (!zywe) return;
  throw new Error(
    `Kanał ${kanal}: odczyt oddał 0 pozycji, a lustro trzyma ${zywe} żywych. To wygląda na awarię `
    + 'sklepu (odmowa kodem 200: konflikt wtyczki, tryb konserwacji, przerwany import), a nie na '
    + 'pusty katalog — więc NIE oznaczam niczego jako zniknięte i zostawiam lustro bez zmian. '
    + 'Jeśli kanał naprawdę został wygaszony, oznacz jego wiersze ręcznie.',
  );
}

/**
 * Jeden kanal: biala lista → odczyt → zapis. Wyjatek NIE WYCHODZI na zewnatrz — wraca jako
 * `blad` w wyniku tego kanalu, zeby pozostale trzy dokonczyly przebieg.
 */
async function przebiegKanalu({ db, kanal, dozwolone, czym, odczytaneAt, zbierz, zapisz }) {
  try {
    if (!dozwolone.includes(kanal)) {
      throw new Error(`„${kanal}" nie jest ${czym} (są: ${dozwolone.join(', ')})`);
    }
    const wiersze = await zbierz();
    // ⚠️ HAMULEC STOI PRZED FAZA ZAPISU I TO JEST CALA JEGO TRESC. Przesuniety za nia chroni
    // juz tylko wynik funkcji: `oznaczZnikniete` zdazylo wtedy wygasic caly katalog kanalu.
    sprawdzPustyOdczyt(db, kanal, wiersze.length);
    const { zapisane, znikniete } = zapiszKanal(db, kanal, wiersze, odczytaneAt);
    return { kanal, zapisane, znikniete, blad: null };
  } catch (e) {
    // ⚠️ `znikniete: 0` NIE JEST tu kosmetyka — kanal, ktory padl, NIE ZOSTAL sprawdzony,
    // wiec nie wolno powiedziec o nim niczego poza bledem.
    const blad = opisBledu(e);
    // ⚠️ SLAD W LOGU JEST TU CZESCIA OCHRONY, nie dodatkiem. Blad wracajacy WYLACZNIE w wyniku
    // jest widoczny tylko wtedy, gdy ktos ten wynik wyswietli — a niewyswietlony blad kanalu
    // wyglada na ekranie DOKLADNIE tak samo jak sklep, w ktorym nic sie nie zmienilo. To ta sama
    // usterka, ktora recenzja pollera zlapala przy Allegro: komunikat ladowal w kolumnie,
    // ktorej nikt nie czytal, a objawial sie „spokojnym dniem".
    zapisz(`magazyn: kanał ${kanal} przerwany —`, blad);
    return { kanal, zapisane: 0, znikniete: 0, blad };
  }
}

/**
 * Odswiezenie lustra ze wszystkich kanalow. Uruchamiane PRZYCISKIEM, nigdy pollerem.
 *
 * @param {object} p
 * @param {object} p.db
 * @param {Record<string, {pobierzWszystkieProdukty, pobierzWarianty}>} [p.sklepy] — klienci Woo
 * @param {Record<string, {pobierzOferty}>} [p.allegro] — MAPA kanal → klient z `klienciKanalow`
 * @param {() => string} [p.teraz] — wstrzykiwany zegar (patrz `znacznik`)
 * @param {(postep: {kanal: string, zrobione: number, zTego: number}) => void} [p.postep]
 * @param {(...czesci: unknown[]) => void} [p.log] — ślad po błędzie kanału; domyślnie `console.error`
 * @returns {Promise<{kanaly: Array<{kanal, zapisane, znikniete, blad}>}>}
 *
 * Odczyt calego katalogu to setki zadan HTTP (warianty ida per produkt wariantowy, Allegro
 * dokłada ~23 strony) i NIE ZMIESCI SIE w limicie czasu zadania HTTP. Dlatego ta funkcja nie
 * wie nic o trasie ani o odpowiedzi: zwykla obietnica plus `postep`, ktory mozna podpiac pod
 * pasek postepu, gdy Zadanie 9 uruchomi ja w tle.
 */
export async function odswiezMagazyn({ db, sklepy, allegro, teraz, postep, log = console.error, kanalySklepow, kanalyAllegro } = {}) {
  wymagajListyKanalow(kanalySklepow);
  wymagajListyKanalow(kanalyAllegro);
  // Zegar pytany RAZ NA PRZEBIEG, przed pierwszym zapytaniem do sklepu. Pytanie o niego przy
  // kazdym wierszu daloby wierszom tego samego przebiegu rozne znaczniki — a `oznaczZnikniete`
  // tnie po jednym z nich, wiec przebieg oznaczylby jako znikniete to, co wlasnie przeczytal.
  const odczytaneAt = znacznik(teraz ?? (() => new Date().toISOString()));

  // Postep jest OZDOBA (ta sama zasada, co miniatury ofert): jego awaria nie ma prawa wywalic
  // kanalu, bo kanal wywalony nie dochodzi do `oznaczZnikniete` — usterka paska postepu
  // zamrazalaby lustro.
  const zglos = (info) => {
    try { postep?.(info); } catch { /* postęp nie jest wynikiem odczytu */ }
  };

  // Ta sama technika i ten sam powod, co przy `postep`: log rzucajacy W BLOKU OBSLUGI BLEDU
  // wyrzucilby wyjatek z `przebiegKanalu`, czyli usterka LOGOWANIA zabilaby izolacje awarii
  // i zatrzymala pozostale kanaly. `log = console.error` jest konwencja `services/`
  // (services/wysylka-ksef.js, bootstrap.js): domyslnie do wyjscia kontenera, wstrzykiwalny
  // wylacznie po to, zeby dalo sie go sprawdzic testem.
  const zapisz = (...czesci) => {
    try { log?.(...czesci); } catch { /* ślad nie jest wynikiem odczytu */ }
  };

  const kanaly = [];
  // Kanaly po kolei, nie rownolegle: rownolegly odczyt uderzalby w oba sklepy naraz, a zapis
  // i tak idzie po jednym polaczeniu do bazy. Przebieg jest z przycisku, wiec czas nie jest
  // tu waluta.
  for (const [kanal, klient] of Object.entries(sklepy ?? {})) {
    kanaly.push(await przebiegKanalu({
      db, kanal, dozwolone: kanalySklepow, czym: 'kanałem sklepu', odczytaneAt,
      zapisz,
      zbierz: () => wierszeSklepu({ kanal, klient, odczytaneAt, zglos, zapisz }),
    }));
  }
  for (const [kanal, klient] of Object.entries(allegro ?? {})) {
    kanaly.push(await przebiegKanalu({
      db, kanal, dozwolone: kanalyAllegro, czym: 'kanałem Allegro', odczytaneAt,
      zapisz,
      zbierz: () => wierszeAllegro({ kanal, klient, odczytaneAt, zglos, kanalyAllegro }),
    }));
  }
  return { kanaly };
}
