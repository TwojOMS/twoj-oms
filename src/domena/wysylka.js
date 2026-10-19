// Nazwy metod, jakie umie rozpoznac ten modul. Eksportowane, zeby config.js mogl
// walidowac wpisy z env bez duplikowania tej listy.
//
// `odbior_osobisty` NIE MA kuriera i to jest jego cala tresc — patrz kurierzy/index.js.
// Metoda istnieje po to, zeby sprzedaz na miejscu dalo sie odroznic od wysylkowej
// (sprzedaz na miejscu, spec Etap 3, punkt 6.2), a nie zeby cokolwiek nadawac.
// ⚠️ ROZDZIELENIE DOSTAWY I POBRANIA (2026-08-01, decyzja wlasciciela). Do tej pory
// „za pobraniem" bylo OSOBNA METODA WYSYLKI (`dpd_pobranie`) i dzialalo, dopoki kurier
// byl jeden. Przy dwoch lista podwaja sie (`inpost_kurier`, `inpost_kurier_pobranie`,
// `inpost_paczkomat`, `inpost_paczkomat_pobranie`), przy Allegro rozjezdza sie zupelnie.
//
// Pobranie jest CECHA PLATNOSCI, nie sposobem dostawy — widac to w trzech niezaleznych
// miejscach: DPD przyjmuje je jako atrybut paczki (<cod>), a nie inna usluge; ekran
// zakladania zamowienia pyta o dostawe i platnosc osobno; a ta sama fizyczna dostawa
// („Kurier DPD") wystepuje w sklepie raz jako `flexible_shipping`, raz jako `local_pickup`
// WYLACZNIE dlatego, ze rozni sie platnoscia.
//
// Dlatego sa teraz DWIE niezalezne wartosci: RODZAJ DOSTAWY (ta lista) i `pobranie` (0/1,
// kolumna obok). Dolozenie kuriera to jeden wpis tutaj, nie dwa.
//
// `inpost_paczkomat` doszedl 2026-08-01 (Etap 2, paczkomaty). Jest tu WYLACZNIE rodzajem
// dostawy — pobranie paczkomatowe jest flaga obok, dokladnie jak przy DPD, a nie osobna
// nazwa. Kuriera InPost na umowie NIE MA (rozpoznanie ShipX: carriers to `inpost_locker`
// i `inpost_letter`), wiec nie ma go tez na tej liscie: metoda, ktorej panel nie umie
// nadac, bylaby obietnica bez pokrycia.
//
// ⚠️ METODY ALLEGRO (2026-08-04). Sa tu, zeby panel umial je NAZWAC i po nich filtrowac —
// a NIE po to, zeby cokolwiek nadawac. Zadna z nich nie ma i nie ma miec wpisu w `DLA_METODY`
// (kurierzy/index.js): paczki tego kanalu nadaje sie w panelu Allegro, wiec nadanie z OMS-u
// znaczyloby DRUGA, platna przesylke do tego samego klienta — i tego nie da sie cofnac.
// Brak wpisu w mapie kurierow JEST tu mechanizmem odmowy, dokladnie jak przy
// `odbior_osobisty`; slownik identyfikatorow siedzi w domain/allegro-dostawa.js.
//
// `allegro_inne` NIE JEST tym samym, co `nieznana`. „Nieznana" znaczy „metoda DO WYJASNIENIA,
// popraw ja na karcie"; `allegro_inne` znaczy „Allegro dolozylo usluge, ktorej jeszcze nie
// nazwalismy" — i nie ma z tym zadnej roboty, bo tego kanalu i tak nie nadajemy.
export const METODY_WYSYLKI = [
  'dpd', 'inpost_paczkomat', 'odbior_osobisty',
  'allegro_dpd', 'allegro_paczkomat', 'allegro_punkt', 'allegro_kurier', 'allegro_inne',
];

/**
 * Czy zamowienie przyszlo KANALEM Allegro — po kolumnie `zamowienia.sklep`, nie po metodzie.
 *
 * ⚠️ TO JEST DYSKRYMINATOR ODMOWY NADANIA i musi nim byc wlasnie `sklep`, a nie
 * `metoda_wysylki`. Metoda jest EDYTOWALNA z karty zamowienia (wysylka_reczna_json), wiec
 * odmowa kluczowana metoda ma furtke: operator przestawia zamowienie z Allegro na `dpd`
 * i panel nadaje mu DRUGA, platna paczke do klienta, ktory dostal juz swoja z Allegro.
 * Kolumna `sklep` jest trwala — ustawia ja poller kanalu przy zapisie i nic z panelu jej
 * nie zmienia (nie ma jej na liscie pol zadnego formularza).
 *
 * Klucze kanalow (np. `allegro_a`, `allegro_b`) sa w konfiguracji kanalow, stala KANALY.
 * Sprawdzamy PREFIKS, a nie liste: dolozenie trzeciego konta Allegro to jeden wpis tam
 * i nic tutaj. Podkreslnik w prefiksie jest istotny — sklep o kluczu „allegrowy" nie jest
 * kanalem Allegro (ta sama pulapka, co przy metodach w masowe.js).
 *
 * PRZ-101.08: klucz kanalu jest dowolny (`OMS_KANALY`), a demo ma `allegro` i `allegro-outlet`.
 * Dlatego DRUGA galaz: klucz kanalu o `typ: 'allegro'` z konfiguracji. Zbior ustawia modul kanalow
 * raz przy budowie aplikacji (`ustawKanalyAllegro`); bez niego (testy domeny, skrypty) zostaje sam
 * prefiks — zachowanie sprzed zmiany. Prefiks WYGRYWA: sklep `allegro_x` z `typ: 'woo'` dalej jest
 * brany za Allegro (strażnik PRZ-062 alarmuje o takim kluczu w instalacji klienta).
 */
let kanalyAllegroZKonfiguracji = new Set();
/** Klucze kanalow `typ: 'allegro'` z konfiguracji uruchomienia — woła wyłącznie moduł kanałów przy budowie. */
export function ustawKanalyAllegro(klucze) { kanalyAllegroZKonfiguracji = new Set(klucze ?? []); }
/** Ustawiony zbior (kopia) — dla zapytan SQL, ktore musza dzielic po kanale tak samo jak predykat. */
export const kanalyAllegro = () => [...kanalyAllegroZKonfiguracji];
export const czyKanalAllegro = (z, klucze = kanalyAllegroZKonfiguracji) => {
  const sklep = String(z?.sklep ?? '');
  return sklep.startsWith('allegro_') || klucze.has(sklep);
};

// Nazwy metod DLA CZLOWIEKA — jedno zrodlo dla kolumny „Dostawa" w tabeli, pola wyboru
// w filtrach i chipa aktywnego filtra. Wpisane osobno w kazdym z tych miejsc rozjechalyby
// sie przy pierwszej zmianie nazwy, a filtr „DPD (pobranie)" pokazywalby wtedy wiersze
// opisane inaczej niz wybrana pozycja listy. 'nieznana' JEST tu, bo to realna wartosc
// kolumny (metoda, ktorej panel nie rozpoznal), a nie brak danych.
export const ETYKIETY_WYSYLKI = {
  // ⚠️ „Kurier DPD", a nie samo „DPD" (prosba właściciela 25.08.2026). Odkad kolumna „Dostawa"
  // pokazuje pelne nazwy uslug Allegro („Allegro Kurier DPD", „Allegro One Box"), samotne
  // „DPD" czytalo sie jak nazwa PRZEWOZNIKA obok nazw USLUG — a to jest nasza wlasna usluga
  // kurierska, na NASZEJ umowie. Para „Kurier DPD" / „Allegro Kurier DPD" mowi teraz wprost,
  // czyja umowa jedzie paczka, i to jest cala roznica, ktora operator musi tu zobaczyc.
  dpd: 'Kurier DPD',
  inpost_paczkomat: 'InPost Paczkomat',
  odbior_osobisty: 'Odbiór osobisty',
  // Metody Allegro. Brzmienie ustalone z wlascicielem („Allegro DPD, Allegro Paczkomat,
  // Allegro Orlen") — kazda zaczyna sie od „Allegro", zeby w kolumnie „Dostawa" od razu bylo
  // widac, ze tej paczki NIE nadaje sie z panelu. `allegro_punkt` zbiera automaty i punkty
  // (ORLEN, DHL BOX, One Box) w jedna nazwe: dla operatora roznica jest zadna, a slownik
  // rozbity na przewoznikow rozjezdzalby sie z kazda nowa usluga Allegro.
  allegro_dpd: 'Allegro Kurier DPD',
  allegro_paczkomat: 'Allegro Paczkomat InPost',
  allegro_punkt: 'Allegro punkt / automat',
  allegro_kurier: 'Allegro One Kurier',
  allegro_inne: 'Allegro — inna metoda',
  nieznana: 'Nieznana metoda',
};

/**
 * Nazwa dostawy DLA CZLOWIEKA, razem z dopiskiem o pobraniu.
 *
 * Skladana TUTAJ, a nie w kazdym widoku osobno: lista, karta, ekran nadania i pozycje
 * filtra maja mowic o tej samej przesylce tak samo. Wczesniej „DPD (pobranie)" bylo
 * osobna WARTOSCIA kolumny, wiec skladac nie bylo czego — po rozdzieleniu dostawy
 * i pobrania trzeba to robic w jednym miejscu, inaczej polowa ekranow zgubi informacje,
 * ze kurier ma cos zainkasowac.
 */
export function etykietaWysylki(metoda, czyPobranie, nazwaDokladna = null) {
  const nazwa = String(nazwaDokladna ?? '').trim() || ETYKIETY_WYSYLKI[metoda] || metoda;
  if (!czyPobranie) return nazwa;
  // ⚠️⚠️ NAZWA ALLEGRO DLA POBRANIA JUZ MOWI „pobranie" („Allegro Kurier DPD pobranie (AD)"
  // — 10 zamowien w probce z 25.08). Bezwarunkowy dopisek dawalby „…pobranie (pobranie)"
  // na karcie, w mailu do klienta i na specyfikacji drukowanej do paczki.
  if (/pobrani/i.test(nazwa)) return nazwa;
  return `${nazwa} (pobranie)`;
}

/**
 * NAZWA DOSTAWY DLA CALEGO ZAMOWIENIA — jedno wejscie dla listy, karty, maila i specyfikacji.
 *
 * Istnieje po to, zeby regula „kiedy nazwa od Allegro jest jeszcze prawdziwa" nie musiala byc
 * powtorzona w siedmiu widokach. Rozjazd tych kopii znaczylby nazwe uslugi na karcie i inna
 * w mailu, ktory dostaje klient.
 *
 * ⚠️⚠️ RECZNA ZMIANA METODY ALBO POBRANIA UNIEWAZNIA NAZWE OD ALLEGRO. `metoda_wysylki_nazwa`
 * opisuje wybor KUPUJACEGO; gdy operator poprawil metode na karcie, powiedzial „paczka jedzie
 * inaczej, niz mowi kanal" — a tamta nazwa pokazana obok poprawionej metody klamalaby o tym,
 * dokad paczka jedzie, dokladnie tam, gdzie operator sprawdza, czy trafil dobrze. To ta sama
 * zasada, co przy `punktOdbioruOpis`: opis nalezy do wartosci, z ktora przyszedl.
 *
 * ⚠️ ALE NIE UZYWAMY TU `metodaZmienionaRecznie` — i to nie jest niedopatrzenie. Tamten
 * predykat laczy trzy rzeczy (metoda, pobranie, PUNKT ODBIORU), a poprawka samego punktu to
 * nadal TA SAMA USLUGA: nazwa metody zostaje prawdziwa. Szerszy warunek gubilby nazwe przy
 * najczestszej korekcie, jaka robi operator.
 */
export function nazwaDostawy(z) {
  return etykietaWysylki(metodaWysylki(z), czyPobranie(z), nazwaAllegroAktualna(z));
}

/**
 * Nazwa od Allegro, JEŚLI jest jeszcze prawdziwa — albo `null`, gdy ręczna zmiana metody
 * lub pobrania ją unieważniła. Cała reguła z akapitu wyżej stoi TUTAJ, w jednym miejscu,
 * bo ma dwóch czytelników: `nazwaDostawy` (kolumna „Dostawa", karta, mail, specyfikacja)
 * i `uslugaDostawy` (rozkład przewoźników w zakładce STATYSTYKI). Druga kopia tego warunku
 * rozjechałaby się przy pierwszej zmianie — a rozjazd tych dwóch wyglądałby dokładnie jak
 * wada, którą recenzja 13.09.2026 tu znalazła.
 */
function nazwaAllegroAktualna(z) {
  const nadpisane = metodaWysylki(z) !== metodaZeSklepu(z) || czyPobranie(z) !== pobranieZeSklepu(z);
  return nadpisane ? null : (z?.metoda_wysylki_nazwa ?? null);
}

/**
 * NAZWA USŁUGI DOSTAWY BEZ DOPISKU O POBRANIU — dla rozkładu przewoźników.
 *
 * ⚠️⚠️ POWSTAŁA Z WADY WAŻNEJ Z RECENZJI 13.09.2026. Zakładka STATYSTYKI wołała
 * `etykietaWysylki(z.metoda_wysylki, false, z.metoda_wysylki_nazwa)` na SUROWYCH kolumnach,
 * więc omijała obie ręczne poprawki: zamówienie przychodzące jako `inpost_paczkomat`
 * i poprawione na karcie na `dpd` pokazywało się na liście jako „Kurier DPD", a w statystyce
 * liczyło się jako „InPost Paczkomat". Dwa ekrany o tej samej paczce mówiły co innego.
 *
 * ⚠️ `czyPobranie = false` JEST TU TREŚCIĄ, nie skrótem, i dlatego ta funkcja istnieje osobno
 * od `nazwaDostawy`: pobranie NIE ROZDZIELA usługi na dwa wiersze rozkładu („Kurier DPD"
 * i „Kurier DPD (pobranie)" nie są dwiema usługami tego samego przewoźnika). Pobranie jest
 * cechą PŁATNOŚCI (niezmiennik z 1.08.2026) i liczy się w sekcji płatności. To świadoma
 * decyzja z własnym testem — a nazwa od Allegro unieważnia się przy zmianie pobrania TAK SAMO,
 * bo opisuje wybór kupującego, nie sposób liczenia.
 */
/**
 * ⚠️⚠️ DOPISEK „pobranie" SCHODZI Z NAZWY USŁUGI — ale WYŁĄCZNIE w rozkładzie statystyk.
 *
 * Prośba właściciela z 13.09.2026 wprost: „Allegro Kurier DPD pobranie policz razem z Allegro
 * Kurier DPD, tak samo Allegro Paczkomaty InPost pobranie". Allegro sprzedaje pobranie jako
 * OSOBNĄ USŁUGĘ o własnej nazwie, więc te same paczki tego samego kuriera stały w rozkładzie
 * jako dwie pozycje — zmierzone na produkcji: 13 zamówień „Allegro Kurier DPD pobranie"
 * obok 43 „Allegro Kurier DPD" i 1 „Allegro Paczkomaty InPost pobranie" obok 11.
 *
 * To DRUGA droga rozdzielenia usługi, niezależna od flagi `pobranie` (tę zdejmuje już
 * `czyPobranie = false` niżej): nasze własne DPD za pobraniem ma `metoda_wysylki_nazwa`
 * puste i scala się przez etykietę kubełka, a Allegro niesie dopisek w samej nazwie.
 *
 * ⚠️ OBCINAMY TYLKO DOPISEK NA KOŃCU — wymagane `\s+` przed słowem. Nazwa, w której
 * „pobranie" jest TREŚCIĄ usługi (hipotetyczne „Pobranie kurierem po Polsce"), zostaje
 * nietknięta; bez tego warunku zniknęłaby cała. Przyrostek po słowie też schodzi, bo
 * zmierzony 25.08.2026 wariant brzmiał „Allegro Kurier DPD pobranie (AD)" — Allegro dokłada
 * takie ogonki bez pytania nas o zdanie.
 *
 * ⛔ `nazwaDostawy` (kolumna „Dostawa", karta, mail, specyfikacja) tego NIE robi i nie ma
 * robić: tam operator musi widzieć, że kurier ma coś zainkasować.
 */
const bezDopiskuPobrania = (nazwa) => {
  const obciete = String(nazwa ?? '').replace(/\s+pobrani\w*\b.*$/i, '').trim();
  return obciete || nazwa;
};

export function uslugaDostawy(z) {
  return etykietaWysylki(metodaWysylki(z), false, bezDopiskuPobrania(nazwaAllegroAktualna(z)));
}

// Decyduje instance_id z konfiguracji sklepu, NIE tytul metody. Tytul to tekst,
// ktory da sie zmienic jednym klikiem w wp-adminie; instance_id nie.
//
// Mapa idzie OD instance_id DO nazwy metody (a nie odwrotnie), bo jeden fizyczny
// kurier moze miec wiele instancji w tej samej strefie Woo — np. "Kurier DPD" (platny)
// i "Darmowa dostawa (DPD)" (nad progiem 199 zl) to DWIE instancje tego samego DPD.
// Mapa metoda -> instance pozwalalaby przypisac tylko jedna instancje na metode i nie
// umialaby wyrazic tego splotu; mapa instance -> metoda pozwala wielu instancjom
// wskazywac na tego samego kuriera.
export function rozpoznajMetodeWysylki(zamowienie, mapa) {
  const linie = zamowienie?.shipping_lines;
  if (!Array.isArray(linie) || linie.length === 0) return 'nieznana';
  // Patrzymy WYLACZNIE na linie[0]: ten sklep oferuje jedna metode wysylki na zamowienie.
  // Sklep, ktory dopusci kilka linii wysylki w jednym zamowieniu, wymaga przemyslenia tego od nowa.
  const id = Number(linie[0].instance_id);
  if (!Number.isFinite(id)) return 'nieznana';
  return mapa?.[id] ?? 'nieznana';
}

// ---------------------------------------------------------------------------------
// RECZNE NADPISANIE METODY WYSYLKI (kolumna `zamowienia.wysylka_reczna_json`)
//
// ⚠️ TO NIE JEST TO SAMO CO `dostawa_reczna_json`. Tamta kolumna trzyma poprawiony ADRES
// odbiorcy (domain/dane-reczne.js); ta trzyma METODE i kwote pobrania. Rozdzielone
// CELOWO: „Przywroc dane ze sklepu" przy adresie nie ma prawa po cichu cofac decyzji
// o pobraniu, a zapis adresu (ktory podmienia CALY JSON) skasowalby metode przy kazdym
// kliknieciu „Zapisz dane do wysylki".
//
// ⚠️ METODA I KWOTA LEZA W JEDNEJ WARTOSCI, i to jest niezmiennik, nie wygoda: nie da sie
// zapisac pobrania bez kwoty ani kwoty bez metody, bo obie sa jednym obiektem. Ta sama
// zasada, co przy `oplacone_at` + `oplacone_recznie` i przy `zwrot_at` + `zwrot_powod`.
//
// Ochrona przed pollerem: kolumny NIE MA na liscie pol w UPDATE zapiszZamowienie
// (db/zamowienia.js) — i to jest cala jej ochrona, dokladnie jak przy danych klienta.
// ---------------------------------------------------------------------------------

// Wszystkie funkcje ponizej sa IDEMPOTENTNE — wolno je wywolac na surowym wierszu z bazy
// I na wierszu przepuszczonym przez zLinii, gdzie `metoda_wysylki` jest juz wartoscia
// EFEKTYWNA, a sklepowa lezy w `metoda_wysylki_sklep`. Bez tego oznaczenie „zmienione
// recznie" porownywaloby wartosc efektywna z nia sama i nigdy by sie nie pokazalo.
const zeSklepu = (z, pole) => (z && Object.hasOwn(z, `${pole}_sklep`) ? z[`${pole}_sklep`] : z?.[pole]);

export const metodaZeSklepu = (z) => zeSklepu(z, 'metoda_wysylki') ?? 'nieznana';
export const kwotaPobraniaZeSklepu = (z) => zeSklepu(z, 'kwota_pobrania') ?? null;

// Uszkodzony JSON (reczny UPDATE w pliku SQLite, przerwany zapis) NIE MOZE wywalic karty —
// wtedy po prostu rzadzi sklep, bo to jedyny bezpieczny domyslny stan. Nadpisanie z metoda
// spoza listy panelu jest smieciem, a nie decyzja: przepuszczenie go daloby `wybierzKuriera`
// metode, ktorej nie zna, a widok — napis, ktorego nikt nie potrafi obsluzyc.
function odczytajNadpisanie(surowy) {
  if (!surowy) return null;
  try {
    const o = JSON.parse(surowy);
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    return METODY_WYSYLKI.includes(o.metoda) ? o : null;
  } catch {
    return null;
  }
}

/** Czy w bazie w ogole lezy nadpisanie — steruje przyciskiem „Przywroc metode ze sklepu". */
export const saNadpisanieWysylki = (z) => odczytajNadpisanie(z?.wysylka_reczna_json) != null;

/**
 * Samo nadpisanie (`{ metoda, kwota_pobrania }`) albo `null`.
 *
 * Potrzebne w JEDNYM miejscu: `przeliczKwoteRecznego` odswieza kwote pobrania takze wtedy,
 * gdy pobranie zostalo wlaczone z karty i siedzi w nadpisaniu, a nie w kolumnie. Idzie
 * przez TA SAMA walidacje, co reszta modulu — smiec w kolumnie ma dalej znaczyc „rzadzi
 * sklep", a nie „przepisz smiec z powrotem".
 */
export const nadpisanieWysylki = (z) => odczytajNadpisanie(z?.wysylka_reczna_json);

/**
 * Czy zamowienie jedzie ZA POBRANIEM — wartosc efektywna (nadpisanie wygrywa z kolumna).
 *
 * ⚠️ Osobna od rodzaju dostawy od 2026-08-01. Wczesniej odpowiedz brzmiala
 * „metoda === dpd_pobranie" i byla rozsiana po dwunastu plikach; teraz jest jedna
 * i kazdy, kto pyta o pieniadze do zainkasowania, pyta wlasnie tutaj.
 */
export function czyPobranie(z) {
  const nadpisanie = odczytajNadpisanie(z?.wysylka_reczna_json);
  if (nadpisanie) return Boolean(nadpisanie.pobranie);
  return Boolean(pobranieZeSklepu(z));
}

export const pobranieZeSklepu = (z) => Boolean(zeSklepu(z, 'pobranie'));

/** Metoda wysylki, ktora panel uwaza za prawdziwa. */
export function metodaWysylki(z) {
  return odczytajNadpisanie(z?.wysylka_reczna_json)?.metoda ?? metodaZeSklepu(z);
}

/**
 * Kwota pobrania, ktora panel uwaza za prawdziwa.
 *
 * ⚠️ TO SA PIENIADZE. Kwota istnieje WYLACZNIE przy metodzie „za pobraniem" — i wlasnie ten
 * warunek jest cala tresc tej funkcji. Zamowienie zlozone jako pobranie ma kwote w kolumnie
 * ze sklepu; przelaczenie go recznie na zwykla wysylke (klient dokonal przedplaty) MUSI te
 * kwote przestac uwzgledniac, inaczej kurier zainkasowalby ja od klienta DRUGI RAZ.
 * Zwracamy null, a nie '0.00': kurierzy/dpd.js rozroznia „brak pobrania" (nie ma <cod>)
 * od kwoty niemozliwej do odczytania (odmowa) i to rozroznienie musi zostac.
 */
export function kwotaPobrania(z) {
  if (!czyPobranie(z)) return null;
  const nadpisanie = odczytajNadpisanie(z?.wysylka_reczna_json);
  return nadpisanie ? (nadpisanie.kwota_pobrania ?? null) : kwotaPobraniaZeSklepu(z);
}

// ---------------------------------------------------------------------------------
// PUNKT ODBIORU (kod paczkomatu InPost + opis lokalizacji)
//
// Kod przychodzi ze sklepu w `meta_data` zamowienia (`_parcel_machine_id`, np. „WRO10B")
// i lezy we WLASNEJ kolumnie `zamowienia.punkt_odbioru` — bo to fakt sklepu, ktory poller
// ma odswiezac. Reczna korekta idzie tam, gdzie wszystkie korekty wysylki: do
// `wysylka_reczna_json`, obok metody i pobrania. Powod jest ten sam co zawsze: poller
// nadpisuje dane sklepu co dwie minuty, wiec poprawka wpisana wprost do kolumny znikaloby
// przy najblizszej synchronizacji (przewodnik OMS, 4.7).
//
// Korekta jest potrzebna z zycia: klient bywa, ze poda kod paczkomatu w uwagach zamiast
// wybrac go w checkoucie — wtedy w kolumnie nie ma nic, a nadac trzeba.
// ---------------------------------------------------------------------------------

export const punktOdbioruZeSklepu = (z) => zeSklepu(z, 'punkt_odbioru') ?? null;
export const punktOdbioruOpisZeSklepu = (z) => zeSklepu(z, 'punkt_odbioru_opis') ?? null;

/**
 * Kod paczkomatu, ktory panel uwaza za prawdziwy — nadpisanie WYGRYWA ze sklepem.
 *
 * ⚠️ Inaczej niz przy kwocie pobrania: tam obecnosc nadpisania KASUJE wartosc sklepowa
 * (brak klucza = „ma nie byc pobrania"), a tutaj brak klucza znaczy „czlowiek o punkcie
 * nie decydowal". Roznica jest celowa i wynika ze stawki. Kwota to decyzja o pieniadzach,
 * ktore ma zainkasowac kurier — przemilczana musi znaczyc zero. Kod paczkomatu to ADRES
 * przesylki: zgubiony przy zwyklym przelaczeniu pobrania zostawilby zamowienie, ktorego
 * nie da sie nadac, mimo ze sklep od poczatku wiedzial, dokad ma jechac.
 */
export function punktOdbioru(z) {
  return odczytajNadpisanie(z?.wysylka_reczna_json)?.punkt_odbioru ?? punktOdbioruZeSklepu(z);
}

/**
 * Opis lokalizacji paczkomatu („Przy Centrum Handlowyn Borek") — sam tekst dla czlowieka.
 *
 * ⚠️ Opis NALEZY DO KODU, z ktorym przyszedl. Gdy czlowiek poprawil kod, opis ze sklepu
 * opisuje INNY paczkomat — pokazany obok poprawionego kodu klamalby o tym, dokad jedzie
 * paczka, i to w miejscu, w ktorym operator wlasnie sprawdza, czy trafil dobrze. Wlasny
 * opis wpisany razem z korekta wygrywa; bez niego wolimy nie powiedziec nic.
 */
export function punktOdbioruOpis(z) {
  const nadpisanie = odczytajNadpisanie(z?.wysylka_reczna_json);
  if (nadpisanie?.punkt_odbioru_opis) return nadpisanie.punkt_odbioru_opis;
  if (punktOdbioru(z) !== punktOdbioruZeSklepu(z)) return null;
  return punktOdbioruOpisZeSklepu(z);
}

/**
 * Czy wysylka ODBIEGA od sklepu — to ona dostaje na karcie oznaczenie „zmienione recznie".
 * Liczone z porownania wartosci, nie z samej obecnosci nadpisania: gdy sklep dogoni reczna
 * decyzje, nie ma juz czego oznaczac (ta sama zasada, co przy danych klienta).
 *
 * ⚠️ POROWNUJE TRZY WARTOSCI — dostawe, pobranie I punkt odbioru. Sama metoda nie wystarcza,
 * bo najczestsza reczna korekta („ten sam DPD, ale za pobraniem") metody w ogole nie rusza:
 * karta pokazywalaby wtedy wlaczone inkaso bez ani slowa o tym, ze zdecydowal o nim czlowiek,
 * a przycisk „Przywroc metode ze sklepu" wygladalby na niepotrzebny. Poprawiony kod
 * paczkomatu jest dokladnie tym samym przypadkiem: metoda zostaje `inpost_paczkomat`,
 * a paczka jedzie gdzie indziej, niz mowi sklep.
 */
export const metodaZmienionaRecznie = (z) => metodaWysylki(z) !== metodaZeSklepu(z)
  || czyPobranie(z) !== pobranieZeSklepu(z)
  || punktOdbioru(z) !== punktOdbioruZeSklepu(z);

/**
 * Bramka na pieniadze: co wolno zapisac jako nadpisanie metody.
 * Zwraca `{ nadpisanie, blad }` — dokladnie jak parsujPaczke i parsujAdresOdbiorcy,
 * bo to ta sama klasa sprawy: bledny formularz, a nie awaria czegokolwiek.
 *
 * ⚠️ TRZY ARGUMENTY OD 2026-08-01, bo pobranie przestalo byc nazwa metody. Formularz na
 * karcie oddaje teraz dwie niezalezne decyzje — dostawe i pobranie — i obie musza przejsc
 * przez TE SAMA bramke. Zgadywanie pobrania z nazwy metody (`metoda === 'dpd_pobranie'`)
 * przy drugim kurierze przepuscilo by `inpost_kurier` jako „bez pobrania" i paczka
 * pojechalaby bez inkasa.
 *
 * Pobranie i kwota lezą w JEDNYM obiekcie razem z metoda — patrz niezmiennik opisany
 * wyzej: nie da sie zapisac pobrania bez kwoty ani kwoty bez decyzji o pobraniu.
 *
 * ⚠️ CZWARTY ARGUMENT OD 2026-08-01 (paczkomaty): kod punktu odbioru. Jest OPCJONALNY
 * i zapisuje sie DOKLADNIE tak, jak kwota pobrania — wylacznie przy metodzie, ktora go
 * w ogole ma. Kod zostawiony przy przelaczeniu na DPD bylby smieciem udajacym adres.
 *
 * ⚠️ PIATY ARGUMENT OD 2026-08-04 (Allegro): CALE ZAMOWIENIE, po to i tylko po to, zeby
 * bramka znala KANAL. Bez niego funkcja widzi wylacznie nazwe metody, a nazwa metody jest
 * tym, co ten formularz wlasnie zmienia — patrz `czyKanalAllegro` wyzej. Argument jest
 * OPCJONALNY (wywolanie bez niego zachowuje sie jak dotad), bo nie kazdy wolajacy ma
 * zamowienie pod reka; jedyny dzisiejszy wolajacy — trasa karty — ma je i podaje.
 */
export function sprawdzZmianeMetody(metoda, czyPobranieWybrane, surowaKwota, surowyPunkt, zamowienie) {
  if (!METODY_WYSYLKI.includes(metoda)) {
    return { nadpisanie: null, blad: `Metoda „${metoda}” nie jest obsługiwana w tym panelu.` };
  }
  // ⚠️ NIEODWRACALNE PIENIADZE. Paczke zamowienia z Allegro nadaje SPRZEDAWCA W PANELU
  // ALLEGRO, na umowie Allegro — panel jej nie nada i nie ma nadawac. Przestawienie metody
  // na dostawe, ktora panel UMIE nadac, jest wiec jedyna droga do drugiej, platnej przesylki
  // do klienta, ktory swoja juz dostal; `podzielDoNadania` czyta wartosc EFEKTYWNA, wiec
  // takie zamowienie poszloby hurtem, bez ani jednego pytania.
  //
  // Odmawiamy KAZDEJ metody spoza kanalu, a nie tylko tych z wpisem w `DLA_METODY`. Warunek
  // „ktore panel umie nadac" trzeba by trzymac w zgodzie z tamta mapa, a pierwszy dolozony
  // kurier (inpost_kurier, Etap 4) otworzylby te furtke z powrotem — po cichu. Poprawka
  // metody W OBREBIE kanalu (allegro_inne → allegro_paczkomat) zostaje mozliwa, bo to jest
  // jedyna reczna korekta, ktora przy tym kanale ma sens.
  if (czyKanalAllegro(zamowienie) && !metoda.startsWith('allegro_')) {
    return {
      nadpisanie: null,
      blad: 'To zamówienie przyszło z Allegro — paczki tego kanału nadajesz w Allegro, więc panel nie '
        + 'pozwala przestawić go na dostawę, którą sam nadaje (poszłaby DRUGA, płatna paczka do klienta, '
        + 'który już dostał swoją). Metodę wolno poprawić tylko w obrębie metod Allegro.',
    };
  }
  // ⚠️ Odbior osobisty z pobraniem to sprzecznosc, nie wariant: inkasuje KURIER, a przy
  // odbiorze na miejscu kuriera nie ma (ta sama odmowa, co przy zakladaniu zamowienia —
  // domain/nowe-zamowienie.js). Wczesniej byla niewyrazalna, bo „odbior_osobisty" i
  // „dpd_pobranie" byly jedna wartoscia; po rozdzieleniu da sie ja kliknac, wiec musi
  // dostac odmowe TUTAJ.
  if (czyPobranieWybrane && metoda === 'odbior_osobisty') {
    return {
      nadpisanie: null,
      blad: 'Odbiór osobisty i pobranie wykluczają się — pobranie inkasuje kurier, a przy odbiorze '
        + 'osobistym kuriera nie ma.',
    };
  }
  // Kod paczkomatu doklejamy do KAZDEGO wariantu ponizej — i tylko przy metodzie, ktora
  // punkt odbioru w ogole ma. Wielkie litery, bo tak wygladaja kody InPostu na etykietach
  // i w API („wro10b" przepisane z uwag klienta zostaloby odrzucone przez ShipX); to ta
  // sama rodzina normalizacji, co telefon bez `+48` (domain/telefon.js).
  const punkt = metoda === 'inpost_paczkomat' ? String(surowyPunkt ?? '').trim().toUpperCase() : '';
  const zPunktem = (o) => (punkt ? { ...o, punkt_odbioru: punkt } : o);

  // Zwykla wysylka NIE ZAPISUJE kwoty w ogole — nie „zapisuje zero". Klucza po prostu nie
  // ma, wiec nie istnieje stan „przedplata z kwota pobrania czekajaca w tle". `pobranie: 0`
  // zapisujemy JAWNIE, bo to decyzja („ma NIE byc pobrania"), ktora musi przebic kolumne
  // ze sklepu — brak klucza czytaloby sie tak samo, ale w logu i w pliku bazy nie widac
  // by bylo, ze ktos ja swiadomie podjal.
  if (!czyPobranieWybrane) return { nadpisanie: zPunktem({ metoda, pobranie: 0 }), blad: null };

  const przycieta = String(surowaKwota ?? '').trim();
  if (!przycieta) {
    return {
      nadpisanie: null,
      blad: 'Przełączenie na pobranie wymaga podania kwoty pobrania — paczka za pobraniem bez kwoty '
        + 'to paczka, za którą kurier nic nie zainkasuje.',
    };
  }
  const kwota = Number(przycieta);
  // Przecinek dziesietny to najczestsza literowka polskiej klawiatury, a Number('12,50')
  // to NaN. Ciche pominiecie wyslaloby paczke jako przedplacona — patrz ten sam straznik
  // po stronie kuriera (kurierzy/dpd.js).
  if (!Number.isFinite(kwota)) {
    return { nadpisanie: null, blad: `Nie umiem odczytać kwoty pobrania: „${przycieta}” (użyj kropki dziesiętnej).` };
  }
  if (kwota <= 0) {
    return { nadpisanie: null, blad: 'Kwota pobrania musi być większa od zera.' };
  }
  return { nadpisanie: zPunktem({ metoda, pobranie: 1, kwota_pobrania: przycieta }), blad: null };
}
