import { describe, it, expect } from 'vitest';
import { propozycje, propozycjeOfert } from '../../src/domena/dopasowanie-ofert.js';

// DOPASOWANIE OFERT ALLEGRO DO WZOROW — miara, od ktorej zalezy, czy ekran powiazan
// oszczedza prace, czy ja produkuje.
//
// ⚠️⚠️ TA SUITA JEST SWIADECTWEM POMIARU NA PRAWDZIWYCH DANYCH (428 roznych nazw ofert,
// 767 produktow sklepowych, 2026-08-11). Kazdy z opisow nizej odtwarza parę, ktora przy
// GORSZEJ mierze ladowala w koszu „bez propozycji" albo trafiala w cudzy wzor. Nazwy sa
// z produkcji i maja tu zostac: to one tlumacza, DLACZEGO miara wyglada tak, a nie inaczej.
//
// Cztery rozstrzygniecia, kazde z wlasnym opisem:
//   (1) obie strony maja doklejone smieci INNEGO rodzaju (Allegro — dopisek sprzedazowy,
//       sklep — rozmiar w nazwie), wiec miara musi byc SYMETRYCZNA (F1 z obu pokryc);
//   (2) tokeny liczbowe sa ZNACZACE — `KWIATY 2/3/4/5` to cztery rozne wzory;
//   (3) rozmiar jest ROZSTRZYGACZEM, nie warunkiem;
//   (4) przy remisie wygrywa dopasowanie bogatsze w wspolne slowa.

// Wzor tak, jak wyglada wiersz tabeli `wzory`: nazwa i (czasem) wymiary w milimetrach.
const wzor = (id, nazwa, szerokosc_mm = null, wysokosc_mm = null) => ({
  id, nazwa, sku: null, szerokosc_mm, wysokosc_mm,
});

// Oferta tak, jak wyglada wiersz lustra: sama nazwa sprzedazowa.
const oferta = (nazwa, reszta = {}) => ({
  id: 1, kanal: 'allegro_szkicownia', nazwa, rozmiar_tekst: null, ...reszta,
});

const nazwy = (lista) => lista.map((p) => p.wzor.nazwa);

describe('propozycje — miara SYMETRYCZNA (F1 z obu pokryc)', () => {
  // ⚠️⚠️ TEN OPIS ZABIJA OBIE MIARY JEDNOSTRONNE NARAZ i dlatego stoi pierwszy.
  //
  // Para z produkcji: oferta „Zakaz palenia papierosów…" ma trafic we wzor
  // „Zakaz palenia - 64cm". Trzej kandydaci sa dobrani tak, zeby kazda miara jednostronna
  // ustawila ich INACZEJ niz F1:
  //
  //   - POKRYCIE NAZWY WZORU (|wspolne| / |slowa wzoru|): „Zakaz" samotny dostaje 1,00
  //     i wygrywa z poprawnym trafieniem. To jest dokladnie ta usterka, ktora w pomiarze
  //     wrzucala poprawne pary technicznych szablonow do kosza „bez propozycji";
  //   - POKRYCIE NAZWY OFERTY (|wspolne| / |slowa oferty|): kandydat poprawny i dlugi
  //     kandydat obcy maja po dwa wspolne slowa z tej samej oferty, wiec ta miara daje
  //     im REMIS i o kolejnosci decyduje przypadek.
  //
  // F1 ustawia ich w jedynej kolejnosci, ktora ma sens.
  it('poprawne trafienie bije i krotszy, i dluzszy blad — „Zakaz palenia papierosów…"', () => {
    const wzory = [
      wzor(1, 'Zakaz palenia - 64cm'),
      wzor(2, 'Zakaz palenia w hali produkcyjnej magazynu wysokiego składowania'),
      wzor(3, 'Zakaz'),
    ];
    const wynik = propozycje(
      oferta('Zakaz palenia papierosów - DUŻY szablon malarski do znakowania'), wzory,
    );

    expect(nazwy(wynik)).toEqual([
      'Zakaz palenia - 64cm',
      'Zakaz palenia w hali produkcyjnej magazynu wysokiego składowania',
      'Zakaz',
    ]);
    // Oceny MALEJA — lista jest posortowana, a nie tylko przypadkiem ulozona.
    expect(wynik[0].ocena).toBeGreaterThan(wynik[1].ocena);
    expect(wynik[1].ocena).toBeGreaterThan(wynik[2].ocena);
  });

  // Druga polowa tej samej pary, od strony sklepu: nazwa sklepowa DLUZSZA od ofertowej.
  // Przy pokryciu liczonym w strone wzoru takie trafienia dostawaly ocene tak niska, ze
  // przy jakimkolwiek progu znikaly z ekranu — a sa poprawne.
  it('nazwa sklepowa dluzsza od ofertowej nadal wygrywa — „STOP…"', () => {
    const wzory = [wzor(1, 'STOP - szablon ostrzegawczy, przemysłowy'), wzor(2, 'STOP')];
    const wynik = propozycje(oferta('STOP - szablon malarski do znakowania posadzek'), wzory);

    expect(nazwy(wynik)).toEqual(['STOP - szablon ostrzegawczy, przemysłowy', 'STOP']);
  });

  // Trzecia para z pomiaru — najkrotsza z wszystkich i przez to najbardziej narazona na
  // odrzucenie progiem. Nazwa oferty i nazwa wzoru roznia sie WYLACZNIE wielkoscia liter.
  it('para roznaca sie tylko wielkoscia liter dostaje ocene maksymalna — „NIE PARKOWAĆ"', () => {
    const wynik = propozycje(oferta('NIE PARKOWAĆ'), [wzor(1, 'Nie parkować'), wzor(2, 'Parking')]);

    expect(wynik[0].wzor.nazwa).toBe('Nie parkować');
    expect(wynik[0].ocena).toBe(1);
  });
});

describe('propozycje — rozmiar w nazwie sklepowej nie psuje dopasowania', () => {
  // ⚠️ Sklep trzyma rozmiar W NAZWIE („Obiekt monitorowany - 60x62cm"), Allegro nie.
  // Bez zdjecia rozmiaru te dwa slowa („60x62cm" jako token) obnizaja pokrycie nazwy
  // sklepowej i spychaja poprawne trafienie pod kandydata przypadkowego. Zdejmuje go
  // ISTNIEJACA `nazwaBezRozmiaru` z domain/rozmiar.js — ta sama, ktora buduje nazwy wzorow.
  it('„60x62cm" w nazwie wzoru nie liczy sie jako slowo', () => {
    const zRozmiarem = propozycje(
      oferta('Obiekt monitorowany - szablon malarski'), [wzor(1, 'Obiekt monitorowany - 60x62cm')],
    );
    const bezRozmiaru = propozycje(
      oferta('Obiekt monitorowany - szablon malarski'), [wzor(1, 'Obiekt monitorowany')],
    );

    // Ta sama ocena w obu przypadkach: rozmiar zniknal z liczenia bez reszty.
    expect(zRozmiarem[0].ocena).toBe(bezRozmiaru[0].ocena);
    expect(zRozmiarem[0].wspolneSlowa).toEqual(['Obiekt', 'monitorowany']);
  });
});

describe('propozycje — tokeny liczbowe sa ZNACZACE', () => {
  // ⚠️⚠️ ZMIERZONE: przy filtrze „slowa dluzsze niz jeden znak" cala rodzina `KWIATY 2/3/4/5`
  // zlewala sie w `Kwiaty 1` — bo po wyrzuceniu cyfry wszystkie cztery nazwy byly IDENTYCZNE,
  // a o zwyciezcy decydowala kolejnosc wierszy w bazie. Cztery rozne wzory, jedna propozycja
  // dla wszystkich: to nie jest slabe dopasowanie, to jest dopasowanie mylace.
  it('KWIATY 4 trafiaja w „Kwiaty 4", a nie w „Kwiaty 1"', () => {
    const wzory = [
      wzor(1, 'Kwiaty 1 - zestaw 5 szt.'),
      wzor(2, 'Kwiaty 2 - zestaw 5 szt.'),
      wzor(3, 'Kwiaty 3 - zestaw 5 szt.'),
      wzor(4, 'Kwiaty 4 - zestaw 5 szt.'),
    ];
    const wynik = propozycje(oferta('KWIATY 4 - szablon malarski na ścianę'), wzory);

    expect(wynik[0].wzor.nazwa).toBe('Kwiaty 4 - zestaw 5 szt.');
    // ⚠️ I JEST SAMOTNY NA SZCZYCIE. Sama pozycja pierwsza nie wystarcza: przy zjedzonej
    // cyfrze wszystkie cztery maja te sama ocene i „pierwszy" znaczy „pierwszy z bazy".
    expect(wynik[0].ocena).toBeGreaterThan(wynik[1].ocena);
    // Cyfra jest WSPOLNYM SLOWEM, a nie smieciem odfiltrowanym przed liczeniem.
    expect(wynik[0].wspolneSlowa).toContain('4');
  });

  // Druga polowa pary: znak pojedynczy BEZ cyfry (spojnik „w", „i", „z") nadal wypada.
  // Gdyby zostawal, dwie nazwy zlaczone tym samym spojnikiem dostawalyby punkt za nic.
  it('samotna litera nie jest slowem, samotna cyfra jest', () => {
    const kandydat = [wzor(1, 'Nakaz jazdy prawo')];
    const zLitera = propozycje(oferta('Nakaz jazdy w prawo'), kandydat);
    const zCyfra = propozycje(oferta('Nakaz jazdy 2 prawo'), kandydat);

    // „w" NIE weszlo do slow oferty, wiec obie nazwy sa slowo w slowo te same.
    expect(zLitera[0].ocena).toBe(1);
    expect(zLitera[0].wspolneSlowa).toEqual(['Nakaz', 'jazdy', 'prawo']);
    // „2" WESZLO — oferta ma o jedno slowo wiecej niz wzor, wiec ocena juz nie jest pelna.
    expect(zCyfra[0].ocena).toBeLessThan(1);
    expect(zCyfra[0].wspolneSlowa).not.toContain('2');
  });
});

describe('propozycje — rozmiar jest ROZSTRZYGACZEM, nie warunkiem', () => {
  // ⚠️ `ANNE 15cm/20cm`, `23cm/28cm`, `28cm/35cm` to TRZY ROZNE WZORY tego samego motywu.
  // Sama nazwa motywu nie rozstrzyga o niczym — rozstrzyga rozmiar, i tu stoi on w nazwie
  // w postaci, ktorej `wymiaryZTekstu` nie uznaje (ukosnik zamiast „x", brak jednostki przy
  // pierwszej liczbie). Dlatego musi dzialac TAKZE jako zwykle slowo.
  it('ANNE 23cm/28cm trafia we wlasciwy z trzech rozmiarow', () => {
    const wzory = [
      wzor(1, 'ANNE 15cm/20cm'),
      wzor(2, 'ANNE 23cm/28cm'),
      wzor(3, 'ANNE 28cm/35cm'),
    ];
    const wynik = propozycje(oferta('Szablon ANNE 23cm/28cm malarski wielorazowy'), wzory);

    expect(wynik[0].wzor.nazwa).toBe('ANNE 23cm/28cm');
    expect(wynik[0].ocena).toBeGreaterThan(wynik[1].ocena);
  });

  // ⚠️ ZGODNY ROZMIAR PODNOSI. Dwie nazwy identyczne co do slowa, a rozne co do wymiaru,
  // maja to samo pokrycie slowne — bez rozstrzygacza kolejnosc bralaby sie z bazy.
  it('zgodny wymiar podnosi ocene ponad ten sam wzor z wymiarem sprzecznym', () => {
    const wzory = [
      wzor(1, 'Obiekt monitorowany', 700, 1000),
      wzor(2, 'Obiekt monitorowany', 600, 620),
    ];
    const wynik = propozycje(oferta('Obiekt monitorowany 60x62 cm szablon'), wzory);

    expect(wynik[0].wzor.id).toBe(2);
    expect(wynik[0].ocena).toBeGreaterThan(wynik[1].ocena);
  });

  // ⚠️⚠️ DRUGA POLOWA PARY: ROZSTRZYGACZ MA MILCZEC, GDY NIE MA CZEGO ROZSTRZYGAC.
  // Wzor bez wymiarow (a takich jest na starcie wiekszosc) NIE MOZE dostac kary za to,
  // ze wymiarow nie ma — inaczej ekran spychalby na dol wszystko, czego jeszcze nie
  // uzupelniono, czyli dokladnie te wzory, ktore najbardziej potrzebuja powiazania.
  it('brak wymiarow po ktorejkolwiek stronie NIE zmienia oceny', () => {
    const bezWymiarow = propozycje(oferta('Obiekt monitorowany 60x62 cm szablon'), [
      wzor(1, 'Obiekt monitorowany'),
    ]);
    const ofertaBezWymiaru = propozycje(oferta('Obiekt monitorowany szablon'), [
      wzor(1, 'Obiekt monitorowany', 600, 620),
    ]);
    const nicPoObuStronach = propozycje(oferta('Obiekt monitorowany szablon'), [
      wzor(1, 'Obiekt monitorowany'),
    ]);

    expect(bezWymiarow[0].ocena).toBe(nicPoObuStronach[0].ocena);
    expect(ofertaBezWymiaru[0].ocena).toBe(nicPoObuStronach[0].ocena);
  });

  // ⚠️ SPRZECZNY ROZMIAR SCINA, ALE NIE WYRZUCA. Wzor z innym wymiarem zostaje na liscie
  // — bo wymiar wzoru bywa niewpisany, wpisany z pomylka albo opisuje inny wariant tego
  // samego motywu. Kandydat schowany to kandydat, ktorego czlowiek nie ma jak poprawic.
  it('sprzeczny wymiar obniza ocene, ale kandydat ZOSTAJE na liscie', () => {
    const wynik = propozycje(oferta('Obiekt monitorowany 60x62 cm'), [
      wzor(1, 'Obiekt monitorowany', 700, 1000),
    ]);

    expect(wynik).toHaveLength(1);
    expect(wynik[0].ocena).toBeGreaterThan(0);
    expect(wynik[0].ocena).toBeLessThan(1);
  });
});

describe('propozycje — remis rozstrzyga bogactwo wspolnych slow', () => {
  // ⚠️ Para z pomiaru: „STRZAŁKA nakaz skrętu w lewo" trafiala w sama „Strzałkę".
  // Tu jest ten sam uklad sprowadzony do remisu: obaj kandydaci maja IDENTYCZNE F1,
  // ale jeden dzieli z oferta cztery slowa, a drugi dwa. Cztery znacza wiecej.
  it('przy tej samej ocenie wygrywa kandydat z wieksza liczba wspolnych slow', () => {
    const wzory = [
      // Dwa wspolne slowa z osmiu wlasnych → pokrycia 2/8 i 2/4.
      wzor(1, 'Strzałka lewa duża czerwona'),
      // Cztery wspolne slowa z osmiu wlasnych → pokrycia 4/8 i 4/8.
      wzor(2, 'Nakaz skrętu w lewo - strzałka kierunkowa podłogowa magazynowa'),
    ];
    const wynik = propozycje(oferta('STRZAŁKA nakaz skrętu w lewo szablon malarski podłogowy'), wzory);

    expect(wynik[0].wzor.id).toBe(2);
    expect(wynik[0].wspolneSlowa.length).toBeGreaterThan(wynik[1].wspolneSlowa.length);
  });

  // ⚠️⚠️ DRUGA POLOWA PARY, I TO ONA PILNUJE KOLEJNOSCI KRYTERIOW. Liczba wspolnych slow
  // rozstrzyga WYLACZNIE remis — postawiona przed ocena robi z niej kryterium glowne,
  // a wtedy wygrywa kazda nazwa DLUGA: im wiecej slow ma wzor, tym wieksza szansa, ze
  // trafi w kilka slow oferty, choc pokrycie ma marne. Tutaj oba kryteria wskazuja
  // PRZECIWNIE: kandydat trafny ma wyzsza ocene i MNIEJ wspolnych slow.
  //
  // (Zmierzone mutacja: sama zamiana kolejnosci tych dwoch linii, bez zmiany ani jednego
  // znaku ich tresci, przechodzila przez cala suite na zielono.)
  it('ocena bije liczbe wspolnych slow, gdy wskazuja przeciwnie', () => {
    const wzory = [
      wzor(1, 'Kotwica morska'),
      wzor(2, 'Kotwica morska szablon malarski ozdobny na ścianę salonu sypialni przedpokoju'),
    ];
    const wynik = propozycje(oferta('Kotwica morska - szablon malarski wielorazowy'), wzory);

    expect(wynik[0].wzor.id).toBe(1);
    // ...i wygral MIMO ze wspolnych slow ma mniej — bez tego zdania test przechodzilby
    // takze wtedy, gdyby oba kryteria wskazywaly to samo.
    expect(wynik[0].wspolneSlowa.length).toBeLessThan(wynik[1].wspolneSlowa.length);
    expect(wynik[0].ocena).toBeGreaterThan(wynik[1].ocena);
  });

  // Kolejnosc ma byc POWTARZALNA miedzy odswiezeniami: pelny remis (ta sama ocena i tyle
  // samo wspolnych slow) rozstrzyga nazwa, a dopiero na koncu identyfikator. Bez tego ten
  // sam ekran pokazywalby raz jednego, raz drugiego kandydata na pierwszym miejscu.
  it('pelny remis rozstrzyga sie powtarzalnie — po nazwie, potem po id', () => {
    const wzory = [wzor(9, 'Kotwica morska'), wzor(3, 'Kotwica morska'), wzor(7, 'Kotwica mała')];
    const a = propozycje(oferta('Kotwica morska szablon'), wzory);
    const b = propozycje(oferta('Kotwica morska szablon'), [...wzory].reverse());

    expect(a.map((p) => p.wzor.id)).toEqual([3, 9, 7]);
    expect(b.map((p) => p.wzor.id)).toEqual(a.map((p) => p.wzor.id));
  });
});

describe('propozycje — ile kandydatow i kiedy zadnego', () => {
  it('domyslnie oddaje TRZECH najlepszych, nie wiecej', () => {
    const wzory = [1, 2, 3, 4, 5].map((i) => wzor(i, `Kotwica wariant ${i}`));
    expect(propozycje(oferta('Kotwica szablon'), wzory)).toHaveLength(3);
    expect(propozycje(oferta('Kotwica szablon'), wzory, { ile: 5 })).toHaveLength(5);
  });

  it('katalog bez wzorow oddaje pusto, a nie wyjatek', () => {
    expect(propozycje(oferta('Kotwica'), [])).toEqual([]);
    expect(propozycje(oferta('Kotwica'), null)).toEqual([]);
  });

  // ⚠️⚠️ TO JEDYNE ODRZUCENIE, JAKIE TU JEST — I NIE JEST PROGIEM JAKOSCI. Zmierzone:
  // przy najlepszej mierze tylko 10% ofert osiaga „pewne", a w kubelku 0,50–0,67 siedza
  // trafienia POPRAWNE. Prog na ocenie chowalby wiec prace, ktora trzeba wykonac.
  // Odrzucamy WYLACZNIE zero wspolnych slow: tam nie ma czego rankowac, a trzy przypadkowe
  // wzory pod oferta to zaproszenie do klikniecia w cudzy wzor.
  it('zero wspolnych slow = brak propozycji; JEDNO wspolne slowo = propozycja JEST', () => {
    const wzory = [wzor(1, 'Kotwica morska'), wzor(2, 'Latarnia')];

    expect(propozycje(oferta('Zakaz palenia'), wzory)).toEqual([]);
    // Druga polowa pary: straznik ma MILCZEC, gdy jest cokolwiek wspolnego. Ocena bywa
    // niska i ma taka byc — od jej czytania jest czlowiek, nie warunek w kodzie.
    const jedno = propozycje(oferta('Kotwica zakaz palenia papierosów duża'), wzory);
    expect(jedno.map((p) => p.wzor.id)).toEqual([1]);
    expect(jedno[0].ocena).toBeGreaterThan(0);
    expect(jedno[0].ocena).toBeLessThan(0.5);
  });

  it('oferta bez ani jednego slowa nie wywala liczenia', () => {
    for (const zla of ['', '   ', '- , -', null, undefined, 42]) {
      expect(propozycje({ nazwa: zla }, [wzor(1, 'Kotwica')]), String(zla)).toEqual([]);
    }
  });

  it('wzor bez nazwy jest pomijany, a reszta katalogu liczy sie dalej', () => {
    const wzory = [{ id: 1, nazwa: null }, { id: 2 }, wzor(3, 'Kotwica morska')];
    expect(propozycje(oferta('Kotwica'), wzory).map((p) => p.wzor.id)).toEqual([3]);
  });
});

// ————————————————————————————————————————————————————————————————————————————————
// DRUGA STRONA TEJ SAMEJ REGULY.
//
// Ekran powiazan pyta „dla TEJ oferty — ktore wzory?", karta wzoru pyta „dla TEGO wzoru —
// ktore oferty?". To jest jedno i to samo pytanie o podobienstwo dwoch nazw, wiec ma na nie
// odpowiadac JEDNA funkcja. Druga kopia reguly rozjezdza sie z pierwsza przy pierwszej
// zmianie — a w tym module „rozjazd" znaczy, ze karta podsuwa inna oferte niz ekran obok.
describe('propozycje — miara jest SYMETRYCZNA takze przy rozmiarze', () => {
  // ⚠️⚠️ TO JEST TEST, KTORY WYMUSIL POPRAWKE W `zRozmiarem`. Wymiary jednej strony stoja
  // w KOLUMNACH (wzor), drugiej w NAZWIE (oferta) — i przed poprawka funkcja szukala ich
  // po STRONIE, a nie po tym, gdzie sa. Zamiana stron gubila wiec rozstrzygajacy rozmiar:
  // ekran powiazan liczyl 63%, a karta tej samej pary 50%.
  it('ta sama para daje TE SAMA ocene niezaleznie od tego, ktora strone pytamy', () => {
    const w = wzor(1, 'Kotwica', 700, 1000);
    const o = oferta('KOTWICA morska duża 70x100cm');

    const zeStronyOferty = propozycje(o, [w]);
    const zeStronyWzoru = propozycje(w, [o]);

    expect(zeStronyOferty).toHaveLength(1);
    expect(zeStronyWzoru).toHaveLength(1);
    expect(zeStronyWzoru[0].ocena).toBe(zeStronyOferty[0].ocena);
    // I rozmiar NAPRAWDE tu rozstrzyga — inaczej ta rownosc bylaby rownoscia dwoch
    // liczb, ktorych zgodnosc wymiaru w ogole nie dotknela.
    expect(zeStronyOferty[0].ocena).toBeGreaterThan(
      propozycje(oferta('KOTWICA morska duża'), [wzor(1, 'Kotwica', 700, 1000)])[0].ocena,
    );
  });

  // ⚠️ KOLUMNA BIJE NAZWE, i to nie jest szczegol implementacji. Na PRO oba zrodla nios
  // ROZNE, PRAWDZIWE liczby: „Teren monitorowany – 60x62cm" ma atrybut „70 x 100 cm", bo
  // 60×62 to WZOR, a 70×100 to ARKUSZ (patrz domain/wzor-z-produktu.js). Magazyn trzyma
  // w kolumnach wymiar ARKUSZA — wpisany albo potwierdzony przez czlowieka — wiec to on
  // rozstrzyga, a nazwa jest tym, co udalo sie odczytac.
  it('wymiar Z KOLUMNY bije wymiar wyczytany z nazwy', () => {
    const w = { id: 1, nazwa: 'Kotwica 20x30cm', sku: null, szerokosc_mm: 700, wysokosc_mm: 1000 };

    const zgodnaZKolumna = propozycje(w, [oferta('KOTWICA morska duża 70x100cm')])[0].ocena;
    const zgodnaZNazwa = propozycje(w, [oferta('KOTWICA morska duża 20x30cm')])[0].ocena;

    expect(zgodnaZKolumna).toBeGreaterThan(zgodnaZNazwa);
  });

  it('rozmiar SPRZECZNY scina ocene tak samo z obu stron', () => {
    const w = wzor(1, 'Kotwica', 700, 1000);
    const o = oferta('KOTWICA morska duża 20x30cm');

    expect(propozycje(w, [o])[0].ocena).toBe(propozycje(o, [w])[0].ocena);
    // Sciety, a nie WYRZUCONY: kandydat schowany to kandydat, ktorego czlowiek nie ma
    // jak poprawic (wymiar bywa niewpisany albo wpisany z pomylka).
    expect(propozycje(w, [o])).toHaveLength(1);
  });

  it('brak wymiaru po ktorejkolwiek stronie zostawia ocene nietknieta — z obu stron', () => {
    const w = wzor(1, 'Kotwica');
    const o = oferta('KOTWICA morska duża 70x100cm');
    const bezRozmiaru = oferta('KOTWICA morska duża');

    expect(propozycje(w, [o])[0].ocena).toBe(propozycje(w, [bezRozmiaru])[0].ocena);
    expect(propozycje(w, [o])[0].ocena).toBe(propozycje(o, [w])[0].ocena);
  });

  it('`propozycjeOfert` to TA SAMA regula, tylko nazwana od strony wzoru', () => {
    const w = wzor(1, 'Kotwica', 700, 1000);
    const oferty = [oferta('KOTWICA morska duża 70x100cm'), oferta('Latarnia morska')];

    const wynik = propozycjeOfert(w, oferty);

    expect(wynik.map((p) => p.oferta.nazwa)).toEqual(['KOTWICA morska duża 70x100cm']);
    // Ocena LICZONA TA SAMA droga — nie „podobna", tylko ta sama.
    expect(wynik[0].ocena).toBe(propozycje(w, oferty)[0].ocena);
    expect(wynik[0].wspolneSlowa).toEqual(propozycje(w, oferty)[0].wspolneSlowa);
  });
});
