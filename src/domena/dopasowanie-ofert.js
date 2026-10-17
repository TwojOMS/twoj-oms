import { nazwaBezRozmiaru, wymiaryZTekstu } from './rozmiar.js';

// DOPASOWANIE OFERTY ALLEGRO DO KARTY — czysta miara podobienstwa nazw.
//
// PO CO TO JEST. Lustro trzyma 447 ofert Allegro i wszystkie maja `karta_id IS NULL`. Karta
// powstaje z katalogu SKLEPU, a oferte wiaze sie z nim RECZNIE: pole `external` jest na
// Allegro puste we wszystkich ofertach, wiec jedynym mostem miedzy tymi dwoma swiatami jest
// NAZWA. Ten modul nie wiaze niczego — oddaje wylacznie ranking kandydatow dla czlowieka,
// ktory kliknie.
//
// ⚠️⚠️ TU NIE MA PROGU I NIE WOLNO GO TU DOPISAC. Zmierzone na prawdziwych danych
// (428 roznych nazw ofert wobec 767 produktow sklepowych, 2026-08-11): przy najlepszej
// mierze tylko okolo 10% ofert osiaga ocene, ktora dalaby sie nazwac „pewna", a w kubelku
// 0,50–0,67 siedza trafienia POPRAWNE — `Lampa stołowa nocna…` → `Lampa stołowa
// - 64cm`, `KOPUŁA…` → `Kopuła - lampa wisząca`, `KINKIET RAMIĘ` → `Kinkiet Ramię`. Prog wyciety
// gdziekolwiek nad zerem chowa wiec przed czlowiekiem prace, ktora trzeba wykonac, i robi
// to CICHO: oferta bez propozycji wyglada tak samo, jak oferta, dla ktorej nic nie ma.
// RANKING JEST DOBRY, PROGI KLAMIA.
//
// Jedyne odrzucenie w tym pliku dotyczy ZERA wspolnych slow — patrz komentarz przy
// `propozycje`. To nie jest prog jakosci, tylko granica miedzy „slabo pasuje" a „nie ma
// zadnego zwiazku".

// ——— SLOWA ———————————————————————————————————————————————————————————————————
//
// ⚠️ SKLADANIE ZNAKOW ZDEJMUJEMY, ALE „ł" NIE MA POSTACI ROZLOZONEJ — NFD go nie rusza,
// wiec para `PODŁOGOWA` / `podlogowa` rozjechalaby sie mimo normalizacji. Allegro i sklep
// pisza te same slowa raz z ogonkami, raz bez (tytul oferty bywa przepisywany recznie),
// wiec fold diakrytykow jest tu warunkiem trafiania, a nie ozdoba.
function bezOgonkow(tekst) {
  return tekst
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/ł/gu, 'l')
    .replace(/Ł/gu, 'L');
}

// ⚠️⚠️ TOKEN JEDNOZNAKOWY ZOSTAJE, GDY NIESIE CYFRE — I TO JEST POMIAR, NIE PRZECZUCIE.
// Przy filtrze „slowa dluzsze niz jeden znak" cala rodzina `ABAŻURY 2/3/4/5` zlewala sie
// w `Abażury 1`: po wyrzuceniu cyfry wszystkie cztery nazwy byly IDENTYCZNE, wiec o tym,
// ktora karta dostanie propozycje, decydowala kolejnosc wierszy w bazie. Cztery rozne karty
// pod jednym kandydatem to nie jest slabe dopasowanie — to jest dopasowanie MYLACE.
//
// Samotna litera (spojnik „i", „w", „z", „o") wypada dalej: dwie nazwy zlaczone tym samym
// spojnikiem dostawalyby za to punkt, a spojnik nie mowi o karcie nic.
const czySlowo = (t) => t.length > 1 || /\d/u.test(t);

/**
 * Slowa nazwy: `{ klucz, tekst }`, bez powtorzen, w kolejnosci wystapienia.
 *
 * `klucz` sluzy porownaniu (male litery, bez ogonkow), `tekst` — pokazaniu czlowiekowi.
 * Dwie postacie tego samego slowa, bo lista „wspolnych slow" na ekranie ma byc czytelna:
 * „podłogowa", a nie „podlogowa".
 *
 * ⚠️ ROZMIAR ZDEJMUJE `nazwaBezRozmiaru` — TA SAMA funkcja, ktora buduje nazwy kart
 * z produktow sklepowych. Sklep trzyma rozmiar w nazwie („Plafon okrągły - 60x62cm"),
 * Allegro nie; policzony jako slowo obnizalby pokrycie kazdej nazwy sklepowej wzgledem
 * kazdej ofertowej. Druga kopia tej reguly tutaj rozjechalaby sie z tamta przy pierwszej
 * poprawce, a wtedy karta nazywalaby sie inaczej, niz szuka jej ten modul.
 */
function slowa(nazwa) {
  if (typeof nazwa !== 'string') return [];
  const bezRozmiaru = nazwaBezRozmiaru(nazwa);
  if (typeof bezRozmiaru !== 'string') return [];

  const wynik = [];
  const widziane = new Set();
  for (const kawalek of bezRozmiaru.split(/[^\p{L}\p{N}]+/u)) {
    if (!kawalek) continue;
    const klucz = bezOgonkow(kawalek).toLowerCase();
    if (!czySlowo(klucz) || widziane.has(klucz)) continue;
    widziane.add(klucz);
    wynik.push({ klucz, tekst: kawalek });
  }
  return wynik;
}

// ——— WYMIARY ——————————————————————————————————————————————————————————————————

// Wymiary z KOLUMN (`karty.szerokosc_mm`/`wysokosc_mm`). Polowiczne to nadal brak — ta sama
// regula, co w filtrze braków w db/magazyn.js: do paczki i do sklepu potrzebne sa oba.
function wymiaryZKolumn(pozycja) {
  const szerokosc_mm = Number(pozycja?.szerokosc_mm);
  const wysokosc_mm = Number(pozycja?.wysokosc_mm);
  if (!(szerokosc_mm > 0) || !(wysokosc_mm > 0)) return null;
  return { szerokosc_mm, wysokosc_mm };
}

/**
 * Wymiary JEDNEJ POZYCJI — obojetne, czy jest nia karta, czy oferta.
 *
 * ⚠️⚠️ SZUKAMY PO TYM, GDZIE WYMIAR JEST, A NIE PO TYM, KTORA STRONA PARY TO JEST. Wcze-
 * sniej stały tu dwie funkcje — jedna czytala kolumny (bo tak ma karta), druga nazwe (bo tak
 * ma oferta) — i przypisane byly na sztywno do STRON porownania. Dopoki pytal wylacznie
 * ekran powiazan („dla tej oferty — ktore karty?"), dzialalo. Ekran karty pyta o to samo
 * z drugiej strony („dla tej karty — ktore oferty?") i przy zamianie stron rozmiar znikal
 * z rachunku po CICHU: ta sama para dostawala 63% na jednym ekranie i 50% na drugim.
 *
 * Kolumny maja pierwszenstwo przed nazwa, bo sa wpisane RECZNIE i rozstrzygaja; nazwa jest
 * tym, co udalo sie odczytac. Zgadywania nie ma zadnego — `wymiaryZTekstu` odmawia
 * wszystkiemu, co niejednoznaczne.
 */
function wymiaryPozycji(pozycja) {
  return wymiaryZKolumn(pozycja)
    ?? wymiaryZTekstu(pozycja?.nazwa)
    ?? wymiaryZTekstu(pozycja?.rozmiar_tekst);
}

// ⚠️⚠️ ROZMIAR JEST ROZSTRZYGACZEM, NIE WARUNKIEM. `KLOSZ 15cm/20cm`, `23cm/28cm`
// i `28cm/35cm` to trzy ROZNE karty tego samego modelu — samo slowo „KLOSZ" nie rozstrzyga
// niczego. Ale wymiar bywa niewpisany (wiekszosc kart startuje bez niego), wpisany
// z pomylka albo opisuje inny wariant tej samej nazwy, wiec sprzeczny SCINA ocene, a nie
// wyrzuca kandydata: kandydat schowany to kandydat, ktorego czlowiek nie ma jak poprawic.
//
// Podniesienie liczone jako ulamek tego, CZEGO BRAKUJE do jedynki — dzieki temu zgodny
// rozmiar nigdy nie wypycha oceny ponad 1 i nie potrafi przeskoczyc dopasowania pelnego.
const PODNIESIENIE_ZGODNEGO = 0.25;
const SCIECIE_SPRZECZNEGO = 0.5;

function zRozmiarem(ocena, zapytanie, kandydat) {
  const a = wymiaryPozycji(zapytanie);
  const b = wymiaryPozycji(kandydat);
  // ⚠️ BRAK WYMIARU PO KTOREJKOLWIEK STRONIE ZOSTAWIA OCENE NIETKNIETA. Kara za brak
  // spychalaby na dol wszystko, czego jeszcze nie uzupelniono — czyli dokladnie te karty,
  // ktore powiazania potrzebuja najbardziej.
  if (!a || !b) return ocena;
  const zgodny = a.szerokosc_mm === b.szerokosc_mm && a.wysokosc_mm === b.wysokosc_mm;
  return zgodny
    ? ocena + (1 - ocena) * PODNIESIENIE_ZGODNEGO
    : ocena * SCIECIE_SPRZECZNEGO;
}

// ——— MIARA ————————————————————————————————————————————————————————————————————

/**
 * Podobienstwo dwoch zbiorow slow — F1 z OBU pokryc.
 *
 * ⚠️⚠️ SYMETRIA JEST TU RZECZA NOSNA, A NIE ELEGANCJA. Obie strony maja doklejone smieci,
 * ale INNEGO rodzaju: Allegro dokleja dopisek sprzedazowy („- DUŻY abażur lniany
 * do sypialni"), sklep — rozmiar i doprecyzowanie techniczne („Kopuła - lampa wisząca,
 * mosiężna"). Pokrycie liczone w JEDNA strone karze wiec systematycznie jedna z nich:
 *
 *   - pokrycie nazwy KARTY (|wspolne| / |slowa karty|) daje 1,00 kazdej karcie krotkiej
 *     („Lampa", „Kopuła"), wiec poprawne trafienie w nazwe techniczna ladowalo pod nim
 *     — a przy jakimkolwiek progu wypadalo z ekranu jako „bez propozycji";
 *   - pokrycie nazwy OFERTY (|wspolne| / |slowa oferty|) nie odroznia kandydata trafnego
 *     od dowolnie dlugiego kandydata obcego o tej samej liczbie wspolnych slow.
 *
 * F1 wymaga OBU naraz i to jest cala jego robota.
 */
function f1(wspolne, ileOferty, ileKarty) {
  if (!wspolne) return 0;
  const pokrycieOferty = wspolne / ileOferty;
  const pokrycieKarty = wspolne / ileKarty;
  return (2 * pokrycieOferty * pokrycieKarty) / (pokrycieOferty + pokrycieKarty);
}

// ⚠️ SLOWA KARTY LICZONE RAZ NA KARTE, A NIE RAZ NA PARE. Ekran powiazan porownuje 447 ofert
// z ~965 kartami, czyli okolo 430 tysiecy par na JEDNO wejscie na strone; tokenizacja nazwy
// karty przy kazdej parze byloby 430 tysiecy przebiegow regexpa zamiast 965. Klucz jest
// SLABY (WeakMap): wiersze przychodza swiezo z bazy przy kazdym zadaniu i maja z niej
// wypasc razem z odpowiedzia, a nie zostac w pamieci kontenera do restartu.
const slowaKarty = new WeakMap();

function slowaKandydata(karta) {
  if (typeof karta !== 'object' || karta === null) return [];
  const gotowe = slowaKarty.get(karta);
  if (gotowe) return gotowe;
  const policzone = slowa(karta.nazwa);
  slowaKarty.set(karta, policzone);
  return policzone;
}

/**
 * ⚠️ REMIS ROZSTRZYGA BOGACTWO WSPOLNYCH SLOW, a nie kolejnosc wierszy w bazie.
 * Zmierzone: „ŁUK lampa podłogowa z marmurem" trafiala w sam „Łuk" zamiast
 * w „Lampa podłogowa z marmurem - łuk", bo obaj kandydaci mieli te sama ocene. Cztery wspolne slowa
 * znacza wiecej niz dwa, nawet przy tym samym pokryciu.
 *
 * Na samym koncu nazwa i identyfikator — nie dlatego, ze cokolwiek znacza, tylko po to,
 * zeby ten sam ekran pokazywal przy kazdym odswiezeniu TE SAMA kolejnosc.
 */
function lepszy(a, b) {
  if (a.ocena !== b.ocena) return a.ocena > b.ocena;
  if (a.wspolne !== b.wspolne) return a.wspolne > b.wspolne;
  const nazwaA = String(a.karta?.nazwa ?? '');
  const nazwaB = String(b.karta?.nazwa ?? '');
  if (nazwaA !== nazwaB) return nazwaA.localeCompare(nazwaB, 'pl') < 0;
  return Number(a.karta?.id) < Number(b.karta?.id);
}

// Wstawienie do listy najlepszych `ile` sztuk. Petla po ~965 kandydatach z sortowaniem
// calosci przy KAZDEJ z 447 ofert to 447 pelnych sortowan tablicy tysiacelementowej;
// tutaj kosztem jest `ile` porownan na kandydata i ani jednej alokacji dla przegranych.
function wstaw(najlepsi, kandydat, ile) {
  let i = najlepsi.length;
  while (i > 0 && lepszy(kandydat, najlepsi[i - 1])) i -= 1;
  if (i >= ile) return;
  najlepsi.splice(i, 0, kandydat);
  if (najlepsi.length > ile) najlepsi.pop();
}

/**
 * Kandydaci na karte dla jednej oferty Allegro — POSORTOWANI, najlepszy pierwszy.
 *
 * @param {{nazwa: string, rozmiar_tekst?: string|null}} oferta wiersz lustra
 * @param {Array<{id: number, nazwa: string, szerokosc_mm?: number|null, wysokosc_mm?: number|null}>} karty
 * @param {{ile?: number}} opcje ilu kandydatow oddac (domyslnie trzech — tylu miesci wiersz)
 * @returns {Array<{karta: object, ocena: number, wspolneSlowa: string[]}>}
 *
 * ⚠️ NICZEGO TU NIE WIAZEMY I NICZEGO NIE ZAPISUJEMY. Funkcja jest czysta, a wybor nalezy
 * do czlowieka: ocena jest PODPOWIEDZIA, nie decyzja (rozstrzygniecie wlasciciela — nic
 * nie wiaze sie bez klikniecia).
 *
 * ⚠️⚠️ ZERO WSPOLNYCH SLOW ODPADA — I TO JEST JEDYNE ODRZUCENIE W TYM PLIKU. To nie jest
 * prog jakosci (progow tu nie ma, patrz naglowek modulu), tylko granica miedzy „slabo
 * pasuje" a „nie ma zadnego zwiazku": przy zerowym pokryciu wszyscy kandydaci maja ocene 0,
 * wiec kolejnosc bralaby sie z bazy, a pod oferta staly by trzy przypadkowe karty. Czlowiek
 * przegladajacy 447 wierszy klika w to, co panel podsunal — a podsuniete losowo trafienie
 * jest gorsze niz puste miejsce i pole wyszukiwania obok.
 */
export function propozycje(oferta, karty, { ile = 3 } = {}) {
  const slowaOferty = slowa(oferta?.nazwa);
  // ⚠️ TO JEST SKROT, A NIE STRAZNIK — i tak ma byc nazwane, zeby nikt go pozniej nie
  // „wzmocnil". Oferta bez slow ma pusty zbior kluczy, wiec `wspolne` bylby zerem przy
  // KAZDYM z ~965 kandydatow i petla i tak oddalaby pusto; `ile` niedodatnie odsiewa
  // `wstaw`. Zysk jest wylacznie taki, ze nie przelatujemy calego katalogu po nic.
  // Mutacja kasujaca te linie JEST rownowazna i suita slusznie jej nie lapie: gdyby
  // lapala, przypinalaby test do optymalizacji zamiast do zachowania.
  if (!slowaOferty.length || !(ile > 0)) return [];

  const kluczeOferty = new Set(slowaOferty.map((s) => s.klucz));
  const najlepsi = [];

  for (const karta of karty ?? []) {
    const kandydat = slowaKandydata(karta);
    if (!kandydat.length) continue;

    let wspolne = 0;
    for (const s of kandydat) if (kluczeOferty.has(s.klucz)) wspolne += 1;
    if (!wspolne) continue;

    const ocena = zRozmiarem(f1(wspolne, kluczeOferty.size, kandydat.length), oferta, karta);
    wstaw(najlepsi, { karta, ocena, wspolne }, ile);
  }

  // Wspolne slowa W POSTACI CZYTELNEJ skladamy dopiero dla zwyciezcow: dla przegranych
  // byloby to kilkaset tysiecy tablic na jedno wejscie na strone, wyrzucanych bez uzycia.
  return najlepsi.map(({ karta, ocena }) => {
    const kluczeKarty = new Set(slowaKandydata(karta).map((s) => s.klucz));
    return {
      karta,
      ocena,
      // Kolejnosc z NAZWY OFERTY — czlowiek czyta ja obok tej nazwy i porownuje wzrokiem.
      wspolneSlowa: slowaOferty.filter((s) => kluczeKarty.has(s.klucz)).map((s) => s.tekst),
    };
  });
}

/**
 * TA SAMA regula, zadana z DRUGIEJ STRONY: dla jednej karty — ktore oferty pasuja.
 *
 * @param {{nazwa: string, szerokosc_mm?: number|null, wysokosc_mm?: number|null}} karta
 * @param {Array<{id: number, nazwa: string, rozmiar_tekst?: string|null}>} oferty
 * @returns {Array<{oferta: object, ocena: number, wspolneSlowa: string[]}>}
 *
 * ⚠️⚠️ TO JEST TRZYLINIJKOWA PRZEKLADKA NAD `propozycje`, A NIE DRUGA IMPLEMENTACJA — i tak
 * ma zostac. Ekran powiazan pyta „dla tej oferty — ktore karty?", ekran karty „dla tej
 * karty — ktore oferty?"; to jest jedno pytanie o podobienstwo dwoch nazw. Wlasna kopia
 * miary w karcie rozjechalaby sie z ekranem obok przy PIERWSZEJ poprawce, a rozjazd znaczy
 * tu, ze dwa ekrany podsuwaja czlowiekowi rozne odpowiedzi na to samo pytanie.
 *
 * Istnieje wylacznie po to, zeby wynik NAZYWAL SIE tym, czym jest po tej stronie (`oferta`,
 * a nie `karta`) — wolajacy nie ma czytac pola `karta` i wiedziec, ze siedzi w nim oferta.
 */
export function propozycjeOfert(karta, oferty, opcje) {
  return propozycje(karta, oferty, opcje)
    .map(({ karta: oferta, ocena, wspolneSlowa }) => ({ oferta, ocena, wspolneSlowa }));
}
