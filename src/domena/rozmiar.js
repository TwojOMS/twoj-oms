// Rozmiar wzoru jest w obu sklepach TEKSTEM — pole `dimensions` WooCommerce jest puste
// w 769 produktach na 769 (zmierzone 2026-08-06). Jedyne zrodla to atrybut „Rozmiar"
// i nazwa produktu.
//
// ⚠️ TA FUNKCJA NIGDY NIE ZGADUJE. Napis niejednoznaczny oddaje null, a wzor powstaje
// bez wymiarow i wpada na liste „bez wymiarow", gdzie czlowiek go uzupelni. Wymiar
// ZGADNIETY jest gorszy niz brak wymiaru: w Etapie 2 to on decyduje, ktory plik .mol
// jedzie na ploter, a bledny wyjdzie dopiero na wycietym szablonie.

// Dwie liczby rozdzielone x/× i jednostka BEZPOSREDNIO po nich. Jednostka jest
// obowiazkowa: „70x100" bez niej moze byc i centymetrami, i milimetrami.
//
// Wzorzec powstaje NA KAZDE WYWOLANIE, a nie raz jako stala modulu. Z flaga `g` regexp
// nosi w sobie `lastIndex`: wspoldzielona stala dziala poprawnie dopoki wszyscy uzywaja
// wylacznie `matchAll` (ono kopiuje regexp), ale pierwsze uzycie `.test()` albo `.exec()`
// zaczyna przesuwac `lastIndex` miedzy wywolaniami i to samo pytanie o ten sam napis
// zaczyna dawac rozne odpowiedzi — bez zadnego bledu, po cichu. Wybieramy swiezy obiekt
// zamiast ostrzezenia w komentarzu, bo ostrzezenia nie da sie zlamac tylko wtedy, gdy
// nie ma czego zlamac; koszt to jedna alokacja regexpu na wywolanie.
function wzorzecRozmiaru() {
  return /(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*(cm|mm)\b/giu;
}

const NA_MM = { cm: 10, mm: 1 };

// JEDNO miejsce prawdy o tym, co w ogole jest „rozmiarem" — i o tym, GDZIE w napisie
// ten rozmiar stoi. Obie funkcje publiczne pytaja tylko tutaj, wiec nie moga sie
// rozjechac: napis, ktoremu odmawiamy wymiarow (zero trafien, dwa trafienia, wymiar
// zerowy albo zaokraglony do zera), jest tym samym napisem, z ktorego nazwaBezRozmiaru
// nie wytnie ani znaku.
function trafienieRozmiaru(tekst) {
  if (typeof tekst !== 'string' || !tekst.trim()) return null;

  const trafienia = [...tekst.matchAll(wzorzecRozmiaru())];

  // Zero trafien = brak rozmiaru. Wiecej niz jedno = napis opisuje kilka rozmiarow
  // („Zestaw 70x100 cm i 45x65 cm") i wybor ktoregokolwiek bylby zgadywaniem.
  if (trafienia.length !== 1) return null;

  const [dopasowanie] = trafienia;
  const [, a, b, jednostka] = dopasowanie;
  const mnoznik = NA_MM[jednostka.toLowerCase()];
  const szerokosc_mm = Math.round(Number(a.replace(',', '.')) * mnoznik);
  const wysokosc_mm = Math.round(Number(b.replace(',', '.')) * mnoznik);

  if (!(szerokosc_mm > 0) || !(wysokosc_mm > 0)) return null;

  return {
    poczatek: dopasowanie.index,
    koniec: dopasowanie.index + dopasowanie[0].length,
    wymiary: { szerokosc_mm, wysokosc_mm },
  };
}

export function wymiaryZTekstu(tekst) {
  const trafienie = trafienieRozmiaru(tekst);
  return trafienie ? trafienie.wymiary : null;
}

// Jeden wymiar z kolumny INTEGER na centymetry. Kolumna jest nullowalna i przyjmie, co jej
// dadza — a „0 × 100 cm" albo „NaN × 100 cm" wygladaloby na prawdziwy wymiar.
export function centymetryZMilimetrow(mm) {
  const n = Number(mm);
  if (!Number.isFinite(n) || !(n > 0)) return null;
  // Bez zaokraglenia do pelnych centymetrow: 305 mm to 30,5 cm, a nie 30 ani 31 — od tej
  // liczby zalezy w Etapie 2, ktory plik jedzie na ploter. `Number(...)` zdejmuje zera
  // koncowe, wiec 700 mm to „70", a nie „70.0".
  return String(Number((n / 10).toFixed(1)));
}

/**
 * Wymiary wzoru na napis dla czlowieka („70 × 100 cm") albo `null`, gdy wymiarow nie ma.
 *
 * Liczy TRASA, nie widok (przewodnik: widok magazynu niczego nie liczy) — a regula stoi
 * tutaj, przy pozostalych regulach rozmiaru, zeby lista i przyszly ekran edycji nie mialy
 * jak nazwac tego samego wymiaru inaczej.
 *
 * ⚠️ POLOWICZNY WYMIAR TO NADAL BRAK WYMIAROW — dokladnie ta sama regula, co w filtrze
 * braków (`db/magazyn.js`: „do ciecia potrzebne sa oba"). Gdyby ta funkcja pokazywala
 * „70 × — cm", wiersz twierdzilby, ze wymiar zna, i JEDNOCZESNIE wpadal do filtru
 * „bez wymiarów" — na ekranie, ktorego cala robota polega na uzupelnianiu tych brakow.
 */
export function opisWymiarow(wzor) {
  const szerokosc = centymetryZMilimetrow(wzor?.szerokosc_mm);
  const wysokosc = centymetryZMilimetrow(wzor?.wysokosc_mm);
  if (szerokosc === null || wysokosc === null) return null;
  return `${szerokosc} × ${wysokosc} cm`;
}

// Jedna liczba i NIC WIECEJ. Zadnej jednostki, zadnego drugiego wymiaru, zadnego wykladnika:
// pole na karcie jest podpisane „cm", wiec „70 mm" i „70x100" to nie sa pomylki literowe,
// tylko dwa rozne zdania niz to, o ktore pole pyta. Napis wykraczajacy poza ten wzorzec
// oddaje `null` („nie rozumiem") — i dopiero warstwa wyzej rozstrzyga, ze to jest ODMOWA
// ZAPISU, a nie ciche wyczyszczenie kolumny.
const SAMA_LICZBA = /^\d+(?:[.,]\d+)?$/u;

/**
 * Jeden wymiar wpisany przez czlowieka w CENTYMETRACH → milimetry do kolumny INTEGER.
 *
 * @param {string} tekst wartosc pola formularza
 * @returns {{mm: number|null}|null} `{ mm }` gdy rozumiemy (pole puste daje `{ mm: null }`,
 *   czyli SWIADOME wyczyszczenie wymiaru), `null` gdy napisu NIE rozumiemy.
 *
 * ⚠️⚠️ KSZTALT ZWROTU JEST TU CALA OSTROZNOSCIA. „Nie rozumiem" i „skasuj" musza byc
 * rozroznialne, bo to sa dwie przeciwne decyzje o tej samej kolumnie — a kolumna opisuje
 * wymiar, po ktorym w Etapie 2 tnie ploter. Gdyby obie wracaly jako `null`, literowka
 * w formularzu kasowalaby wymiar po cichu. Sam `null` w miejscu obiektu wywraca sie na
 * pierwszym `.mm` (glosno), a nie zamienia w `null` przy `??` (cicho).
 *
 * ⚠️ CENTYMETRY WCHODZA, MILIMETRY WYCHODZA — przeliczenie stoi TUTAJ, w jednym miejscu,
 * razem z reszta regul rozmiaru. Formularz mowi w centymetrach, bo tak czlowiek mysli
 * o szablonie; baza trzyma milimetry, bo tak sie je tnie i sortuje.
 */
export function milimetryZCentymetrow(tekst) {
  // Pole nieprzyslane albo przyslane dwa razy (Fastify oddaje wtedy TABLICE) to nie jest
  // pusty napis — tego nie rozumiemy i nie mamy prawa uznac za „skasuj".
  if (typeof tekst !== 'string') return null;

  const s = tekst.trim();
  if (!s) return { mm: null };
  if (!SAMA_LICZBA.test(s)) return null;

  // Zaokraglenie TAKIE SAMO, jak przy rozmiarze wyczytanym z nazwy (`trafienieRozmiaru`) —
  // inaczej „10,55 cm" znaczyloby co innego wpisane recznie, a co innego odczytane ze sklepu.
  const mm = Math.round(Number(s.replace(',', '.')) * 10);
  // Zero i wartosci ujemne odpadaja z tego samego powodu, co przy odczycie z tekstu:
  // „0 × 100 cm" wyglada jak prawdziwy wymiar, a nim nie jest.
  return mm > 0 ? { mm } : null;
}

// Wszystko, co w nazwie produktu sklepikarz stawia MIEDZY czlonami: biale znaki,
// myslniki (dywiz, polpauza, pauza), przecinek i srednik. Rozmiar przyklejony do takiego
// znaku zabiera go ze soba, bo bez rozmiaru ten znak nie ma juz czego rozdzielac.
//
// ⚠️ NAWIASOW W TEJ KLASIE NIE MA — I NIE MOGA TU WROCIC. Poprzednia wersja je tu
// trzymala i obcinala bezwarunkowo, przez co zzerala nawias, ktory rozmiaru wcale nie
// opakowywal: „Teren monitorowany (zolty) – 60x62cm" dawalo „Teren monitorowany (zolty",
// a „CYFRY 70x100cm (Arial)" dawalo „CYFRY Arial)". Nawias nie jest separatorem —
// jest POLOWA PARY i rozstrzyga sie go nizej, patrzac na obie strony rozmiaru naraz.
const SPOIWO_OD_KONCA = /[\s\-–—,;]+$/u;
const SPOIWO_OD_POCZATKU = /^[\s\-–—,;]+/u;

// Nawias opakowuje rozmiar tylko wtedy, gdy TUZ przed rozmiarem stoi znak otwierajacy,
// a TUZ za nim jego wlasne domkniecie. Mapa (a nie zwykly obiekt) po to, zeby zapytanie
// o dowolny znak nazwy nie trafilo przypadkiem w prototyp Object i nie udalo pary.
const DOMKNIECIE = new Map([['(', ')'], ['[', ']'], ['{', '}']]);

// Znak, ktory realnie NIESIE podzial — w odroznieniu od samej spacji. Jesli wystapil
// po ktorejkolwiek stronie rozmiaru, to on wraca jako spoiwo.
const MOCNY_ZNAK = /[-–—,;]/u;

// Nazwa produktu w obu sklepach czesto NIESIE rozmiar w sobie („Teren monitorowany –
// 60x62cm") — do listy magazynu i do generatora SKU potrzebna jest sama nazwa wzoru,
// bez tego dopisku. Ta funkcja usuwa WYLACZNIE to, co `trafienieRozmiaru` rozpoznaje
// jednoznacznie jako rozmiar — te same przypadki, ktore wymiaryZTekstu oddaje jako null,
// tutaj zostawiaja nazwe nietknieta z tego samego powodu: nie ma pewnosci, co wyciac.
//
// KONTRAKT: string → string. Wejscie INNEGO typu wraca IDENTYCZNE (ta sama wartosc, ta
// sama referencja) — funkcja nigdy nie konwertuje go na tekst. To nie jest niedbalstwo,
// tylko ta sama zasada, co „nigdy nie zgaduj": String(60) dalby '60', czyli wiarygodnie
// wygladajaca nazwe wzoru, i zamaskowal blad wyzej (numer wpuszczony tam, gdzie mial isc
// tytul produktu). Oddany bez zmiany numer zostaje numerem i potyka sie o niego pierwszy
// zapis do magazynu. `null`/`undefined` juz tak dzialaly — reszta typow zachowuje sie
// tak samo, zeby kontrakt mial jedna regule zamiast dwoch.
export function nazwaBezRozmiaru(nazwa) {
  if (typeof nazwa !== 'string') return nazwa;

  const trafienie = trafienieRozmiaru(nazwa);
  if (!trafienie) return nazwa;

  const przed = nazwa.slice(0, trafienie.poczatek);
  const po = nazwa.slice(trafienie.koniec);

  // Sedno konstrukcji: NIE czyscimy brzegow gotowego wyniku (to trzy razy z rzedu
  // przesuwalo usterke gdzie indziej), tylko obcinamy spoiwo z WEWNETRZNYCH krawedzi —
  // z konca `przed` i z poczatku `po`, kazda strona osobno. Krawedzie ZEWNETRZNE
  // (poczatek `przed`, koniec `po`) nalezaly do nazwy, nie do rozmiaru, i zostaja
  // nietkniete: „- Kotwica 70x100cm" ma dac „- Kotwica", tak samo jak „- Kotwica"
  // bez rozmiaru daje „- Kotwica".
  let lewy = przed.replace(SPOIWO_OD_KONCA, '');
  let prawy = po.replace(SPOIWO_OD_POCZATKU, '');

  // Nawias rozstrzygamy PARAMI, a nie jak zwykle spoiwo. Znak otwierajacy na wewnetrznej
  // krawedzi lewej strony nalezy do rozmiaru tylko wtedy, gdy po drugiej stronie stoi
  // JEGO domkniecie — wtedy para opakowywala rozmiar i ginie razem z nim. W kazdym innym
  // ukladzie nawias opisuje CZLON NAZWY („(zolty)", „[PROMOCJA]", „(Arial)") i zostaje;
  // znak bez pary tez zostaje, bo wyciecie polowki pary tworzy nazwe, ktorej w sklepie
  // nigdy nie bylo. Sprawdzamy krawedzie juz oczyszczone ze zwyklego spoiwa, wiec
  // „Kotwica - (70x100cm) Premium" liczy sie tak samo jak „Kotwica (70x100cm) Premium".
  const otwierajacy = lewy.slice(-1);
  const domkniecie = DOMKNIECIE.get(otwierajacy);
  const opakowanie = domkniecie !== undefined && prawy.startsWith(domkniecie);
  if (opakowanie) {
    // Po zdjeciu pary trzeba jeszcze raz obciac zwykle spoiwo: nawias mogl byc oddzielony
    // od nazwy spacja („Kotwica ( 70x100cm ) Premium").
    lewy = lewy.slice(0, -1).replace(SPOIWO_OD_KONCA, '');
    prawy = prawy.slice(1).replace(SPOIWO_OD_POCZATKU, '');
  }

  // Dopiero teraz, znajac to, co REALNIE zostalo po obu stronach, rozstrzygamy o spoiwie.
  // Wstawiamy je tylko wtedy, gdy obie strony sa niepuste — jesli rozmiar byl skrajnym
  // czlonem nazwy, jego separator nie ma juz czego rozdzielac.
  let spoiwo = '';
  if (lewy && prawy) {
    // Kandydaci: to, co realnie stalo przy rozmiarze z lewej i z prawej. Nawias, ktory
    // opakowywal rozmiar, wypada z kandydatow — jako spoiwo dalby niesparowany znak
    // („Kotwica(Premium"). Usuwamy DOKLADNIE ten jeden znak (replace z tekstem, nie
    // z regexpem `g`: nie ma tu wspoldzielonego `lastIndex`, ktory moglby przeciec
    // miedzy wywolaniami), a nie wszystkie nawiasy — pozostale naleza do nazwy.
    let zLewej = przed.slice(lewy.length);
    let zPrawej = po.slice(0, po.length - prawy.length);
    if (opakowanie) {
      zLewej = zLewej.replace(otwierajacy, '');
      zPrawej = zPrawej.replace(domkniecie, '');
    }

    // Wraca DOKLADNIE JEDEN separator i to ten, ktory faktycznie wystapil w oryginale —
    // obojetne, po ktorej stronie rozmiaru stal. Myslnik/przecinek bije spacje, bo nosi
    // podzial, ktorego autor nazwy chcial („Kotwica - 70x100cm Premium" to nadal
    // „Kotwica - Premium"). Przy remisie wygrywa lewa strona — czytamy nazwe od lewej.
    if (MOCNY_ZNAK.test(zLewej)) spoiwo = zLewej;
    else if (MOCNY_ZNAK.test(zPrawej)) spoiwo = zPrawej;
    // Ostatnia deska: para nawiasow byla JEDYNYM podzialem miedzy czlonami
    // („Kotwica(70x100cm)Premium"). Sam nawias wrocic nie moze, ale podzial musi —
    // bez niego dwa czlony zlepiaja sie w „KotwicaPremium", czyli w nazwe, ktorej nikt
    // nie wpisal. Ten sam uklad na myslniku daje „Kotwica-Premium", wiec wersja
    // nawiasowa nie ma prawa jako jedyna gubic granice miedzy czlonami.
    else spoiwo = zLewej || zPrawej || (opakowanie ? ' ' : '');

    // Zwijamy WYLACZNIE tu, w skladanym spoiwie — nigdy w `lewy`/`prawy`. `zLewej`/
    // `zPrawej` to resztki po zdjeciu samego znaku nawiasu (albo pary myslnik+spacja),
    // a taki znak potrafi stac MIEDZY dwoma bialymi znakami, ktore osobno przetrwaly
    // obcinanie brzegow: „Kotwica ( 70x100cm ) Premium" zostawia po kazdej stronie
    // nawiasu jedna spacje, a po jego wycieciu te dwie spacje sasiaduja i sklejaja sie
    // w jeden napis dwuznakowy. To lamie kontrakt „dokladnie jeden separator" ponizej —
    // wiec normalizujemy tu, punktowo, zanim spoiwo trafi do `wynik`. Nie robimy tego
    // wyzej, na `lewy`/`prawy`: wielokrotna spacja bedaca CZESCIA nazwy POZA spoiwem
    // („Kotwica  duza 70x100cm") nie ma z separatorem rozmiaru nic wspolnego i ma
    // przezyc nietknieta — normalizacja spoiwa jej nie widzi, bo nigdy do niego nie trafia.
    spoiwo = spoiwo.replace(/\s+/gu, ' ');
  }

  const wynik = `${lewy}${spoiwo}${prawy}`;

  // Nazwa zlozona z samego rozmiaru („60x62cm") nie moze zniknac w pusty string —
  // wzor bez nazwy jest gorszy niz wzor, ktorego nazwa TO rozmiar, wiec oddajemy
  // oryginal bez zadnej modyfikacji (rowniez bez przycietego bialego znaku).
  return wynik || nazwa;
}
