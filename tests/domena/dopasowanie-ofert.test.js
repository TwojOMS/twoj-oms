import { describe, it, expect } from 'vitest';
import { propozycje, propozycjeOfert } from '../../src/domena/dopasowanie-ofert.js';

// DOPASOWANIE OFERT ALLEGRO DO KART — miara, od ktorej zalezy, czy ekran powiazan
// oszczedza prace, czy ja produkuje.
//
// ⚠️⚠️ TA SUITA JEST SWIADECTWEM POMIARU NA PRAWDZIWYCH DANYCH (428 roznych nazw ofert,
// 767 produktow sklepowych, 2026-08-11). Kazdy z opisow nizej odtwarza parę, ktora przy
// GORSZEJ mierze ladowala w koszu „bez propozycji" albo trafiala w cudza karte. Nazwy sa
// zmyslone, ale ich KSZTALT (liczba slow, slowa wspolne, ogonki, wielkie litery) odtwarza
// pary z produkcji — to on tlumaczy, DLACZEGO miara wyglada tak, a nie inaczej.
//
// Cztery rozstrzygniecia, kazde z wlasnym opisem:
//   (1) obie strony maja doklejone smieci INNEGO rodzaju (Allegro — dopisek sprzedazowy,
//       sklep — rozmiar w nazwie), wiec miara musi byc SYMETRYCZNA (F1 z obu pokryc);
//   (2) tokeny liczbowe sa ZNACZACE — `ABAŻURY 2/3/4/5` to cztery rozne karty;
//   (3) rozmiar jest ROZSTRZYGACZEM, nie warunkiem;
//   (4) przy remisie wygrywa dopasowanie bogatsze w wspolne slowa.

// Karta tak, jak wyglada wiersz tabeli `karty`: nazwa i (czasem) wymiary w milimetrach.
const karta = (id, nazwa, szerokosc_mm = null, wysokosc_mm = null) => ({
  id, nazwa, sku: null, szerokosc_mm, wysokosc_mm,
});

// Oferta tak, jak wyglada wiersz lustra: sama nazwa sprzedazowa.
const oferta = (nazwa, reszta = {}) => ({
  id: 1, kanal: 'allegro_szkicownia', nazwa, rozmiar_tekst: null, ...reszta,
});

const nazwy = (lista) => lista.map((p) => p.karta.nazwa);

describe('propozycje — miara SYMETRYCZNA (F1 z obu pokryc)', () => {
  // ⚠️⚠️ TEN OPIS ZABIJA OBIE MIARY JEDNOSTRONNE NARAZ i dlatego stoi pierwszy.
  //
  // Para z produkcji: oferta „Lampa stołowa nocna…" ma trafic w karte
  // „Lampa stołowa - 64cm". Trzej kandydaci sa dobrani tak, zeby kazda miara jednostronna
  // ustawila ich INACZEJ niz F1:
  //
  //   - POKRYCIE NAZWY KARTY (|wspolne| / |slowa karty|): „Lampa" samotna dostaje 1,00
  //     i wygrywa z poprawnym trafieniem. To jest dokladnie ta usterka, ktora w pomiarze
  //     wrzucala poprawne pary z nazwami technicznymi do kosza „bez propozycji";
  //   - POKRYCIE NAZWY OFERTY (|wspolne| / |slowa oferty|): kandydat poprawny i dlugi
  //     kandydat obcy maja po dwa wspolne slowa z tej samej oferty, wiec ta miara daje
  //     im REMIS i o kolejnosci decyduje przypadek.
  //
  // F1 ustawia ich w jedynej kolejnosci, ktora ma sens.
  it('poprawne trafienie bije i krotszy, i dluzszy blad — „Lampa stołowa nocna…"', () => {
    const karty = [
      karta(1, 'Lampa stołowa - 64cm'),
      karta(2, 'Lampa stołowa w stylu skandynawskim salonu dużego mieszkania'),
      karta(3, 'Lampa'),
    ];
    const wynik = propozycje(
      oferta('Lampa stołowa nocna - DUŻY abażur lniany do sypialni'), karty,
    );

    expect(nazwy(wynik)).toEqual([
      'Lampa stołowa - 64cm',
      'Lampa stołowa w stylu skandynawskim salonu dużego mieszkania',
      'Lampa',
    ]);
    // Oceny MALEJA — lista jest posortowana, a nie tylko przypadkiem ulozona.
    expect(wynik[0].ocena).toBeGreaterThan(wynik[1].ocena);
    expect(wynik[1].ocena).toBeGreaterThan(wynik[2].ocena);
  });

  // Druga polowa tej samej pary, od strony sklepu: nazwa sklepowa DLUZSZA od ofertowej.
  // Przy pokryciu liczonym w strone karty takie trafienia dostawaly ocene tak niska, ze
  // przy jakimkolwiek progu znikaly z ekranu — a sa poprawne.
  it('nazwa sklepowa dluzsza od ofertowej nadal wygrywa — „KOPUŁA…"', () => {
    const karty = [karta(1, 'Kopuła - lampa wisząca, mosiężna'), karta(2, 'Kopuła')];
    const wynik = propozycje(oferta('KOPUŁA - lampa sufitowa do jadalni kuchni'), karty);

    expect(nazwy(wynik)).toEqual(['Kopuła - lampa wisząca, mosiężna', 'Kopuła']);
  });

  // Trzecia para z pomiaru — najkrotsza z wszystkich i przez to najbardziej narazona na
  // odrzucenie progiem. Nazwa oferty i nazwa karty roznia sie WYLACZNIE wielkoscia liter.
  it('para roznaca sie tylko wielkoscia liter dostaje ocene maksymalna — „KINKIET RAMIĘ"', () => {
    const wynik = propozycje(oferta('KINKIET RAMIĘ'), [karta(1, 'Kinkiet Ramię'), karta(2, 'Kinkiety')]);

    expect(wynik[0].karta.nazwa).toBe('Kinkiet Ramię');
    expect(wynik[0].ocena).toBe(1);
  });
});

describe('propozycje — rozmiar w nazwie sklepowej nie psuje dopasowania', () => {
  // ⚠️ Sklep trzyma rozmiar W NAZWIE („Plafon okrągły - 60x62cm"), Allegro nie.
  // Bez zdjecia rozmiaru te dwa slowa („60x62cm" jako token) obnizaja pokrycie nazwy
  // sklepowej i spychaja poprawne trafienie pod kandydata przypadkowego. Zdejmuje go
  // ISTNIEJACA `nazwaBezRozmiaru` z domain/rozmiar.js — ta sama, ktora buduje nazwy kart.
  it('„60x62cm" w nazwie karty nie liczy sie jako slowo', () => {
    const zRozmiarem = propozycje(
      oferta('Plafon okrągły - klosz szklany'), [karta(1, 'Plafon okrągły - 60x62cm')],
    );
    const bezRozmiaru = propozycje(
      oferta('Plafon okrągły - klosz szklany'), [karta(1, 'Plafon okrągły')],
    );

    // Ta sama ocena w obu przypadkach: rozmiar zniknal z liczenia bez reszty.
    expect(zRozmiarem[0].ocena).toBe(bezRozmiaru[0].ocena);
    expect(zRozmiarem[0].wspolneSlowa).toEqual(['Plafon', 'okrągły']);
  });
});

describe('propozycje — tokeny liczbowe sa ZNACZACE', () => {
  // ⚠️⚠️ ZMIERZONE: przy filtrze „slowa dluzsze niz jeden znak" cala rodzina `ABAŻURY 2/3/4/5`
  // zlewala sie w `Abażury 1` — bo po wyrzuceniu cyfry wszystkie cztery nazwy byly IDENTYCZNE,
  // a o zwyciezcy decydowala kolejnosc wierszy w bazie. Cztery rozne karty, jedna propozycja
  // dla wszystkich: to nie jest slabe dopasowanie, to jest dopasowanie mylace.
  it('ABAŻURY 4 trafiaja w „Abażury 4", a nie w „Abażury 1"', () => {
    const karty = [
      karta(1, 'Abażury 1 - zestaw 5 szt.'),
      karta(2, 'Abażury 2 - zestaw 5 szt.'),
      karta(3, 'Abażury 3 - zestaw 5 szt.'),
      karta(4, 'Abażury 4 - zestaw 5 szt.'),
    ];
    const wynik = propozycje(oferta('ABAŻURY 4 - lniane do lamp stołowych'), karty);

    expect(wynik[0].karta.nazwa).toBe('Abażury 4 - zestaw 5 szt.');
    // ⚠️ I JEST SAMOTNY NA SZCZYCIE. Sama pozycja pierwsza nie wystarcza: przy zjedzonej
    // cyfrze wszystkie cztery maja te sama ocene i „pierwszy" znaczy „pierwszy z bazy".
    expect(wynik[0].ocena).toBeGreaterThan(wynik[1].ocena);
    // Cyfra jest WSPOLNYM SLOWEM, a nie smieciem odfiltrowanym przed liczeniem.
    expect(wynik[0].wspolneSlowa).toContain('4');
  });

  // Druga polowa pary: znak pojedynczy BEZ cyfry (spojnik „w", „i", „z") nadal wypada.
  // Gdyby zostawal, dwie nazwy zlaczone tym samym spojnikiem dostawalyby punkt za nic.
  it('samotna litera nie jest slowem, samotna cyfra jest', () => {
    const kandydat = [karta(1, 'Kinkiet mosiężny prawy')];
    const zLitera = propozycje(oferta('Kinkiet mosiężny w prawy'), kandydat);
    const zCyfra = propozycje(oferta('Kinkiet mosiężny 2 prawy'), kandydat);

    // „w" NIE weszlo do slow oferty, wiec obie nazwy sa slowo w slowo te same.
    expect(zLitera[0].ocena).toBe(1);
    expect(zLitera[0].wspolneSlowa).toEqual(['Kinkiet', 'mosiężny', 'prawy']);
    // „2" WESZLO — oferta ma o jedno slowo wiecej niz karta, wiec ocena juz nie jest pelna.
    expect(zCyfra[0].ocena).toBeLessThan(1);
    expect(zCyfra[0].wspolneSlowa).not.toContain('2');
  });
});

describe('propozycje — rozmiar jest ROZSTRZYGACZEM, nie warunkiem', () => {
  // ⚠️ `KLOSZ 15cm/20cm`, `23cm/28cm`, `28cm/35cm` to TRZY ROZNE KARTY tego samego modelu.
  // Sama nazwa modelu nie rozstrzyga o niczym — rozstrzyga rozmiar, i tu stoi on w nazwie
  // w postaci, ktorej `wymiaryZTekstu` nie uznaje (ukosnik zamiast „x", brak jednostki przy
  // pierwszej liczbie). Dlatego musi dzialac TAKZE jako zwykle slowo.
  it('KLOSZ 23cm/28cm trafia we wlasciwy z trzech rozmiarow', () => {
    const karty = [
      karta(1, 'KLOSZ 15cm/20cm'),
      karta(2, 'KLOSZ 23cm/28cm'),
      karta(3, 'KLOSZ 28cm/35cm'),
    ];
    const wynik = propozycje(oferta('Lampa KLOSZ 23cm/28cm szklany opalowy'), karty);

    expect(wynik[0].karta.nazwa).toBe('KLOSZ 23cm/28cm');
    expect(wynik[0].ocena).toBeGreaterThan(wynik[1].ocena);
  });

  // ⚠️ ZGODNY ROZMIAR PODNOSI. Dwie nazwy identyczne co do slowa, a rozne co do wymiaru,
  // maja to samo pokrycie slowne — bez rozstrzygacza kolejnosc bralaby sie z bazy.
  it('zgodny wymiar podnosi ocene ponad te sama karte z wymiarem sprzecznym', () => {
    const karty = [
      karta(1, 'Plafon okrągły', 700, 1000),
      karta(2, 'Plafon okrągły', 600, 620),
    ];
    const wynik = propozycje(oferta('Plafon okrągły 60x62 cm klosz'), karty);

    expect(wynik[0].karta.id).toBe(2);
    expect(wynik[0].ocena).toBeGreaterThan(wynik[1].ocena);
  });

  // ⚠️⚠️ DRUGA POLOWA PARY: ROZSTRZYGACZ MA MILCZEC, GDY NIE MA CZEGO ROZSTRZYGAC.
  // Karta bez wymiarow (a takich jest na starcie wiekszosc) NIE MOZE dostac kary za to,
  // ze wymiarow nie ma — inaczej ekran spychalby na dol wszystko, czego jeszcze nie
  // uzupelniono, czyli dokladnie te karty, ktore najbardziej potrzebuja powiazania.
  it('brak wymiarow po ktorejkolwiek stronie NIE zmienia oceny', () => {
    const bezWymiarow = propozycje(oferta('Plafon okrągły 60x62 cm klosz'), [
      karta(1, 'Plafon okrągły'),
    ]);
    const ofertaBezWymiaru = propozycje(oferta('Plafon okrągły klosz'), [
      karta(1, 'Plafon okrągły', 600, 620),
    ]);
    const nicPoObuStronach = propozycje(oferta('Plafon okrągły klosz'), [
      karta(1, 'Plafon okrągły'),
    ]);

    expect(bezWymiarow[0].ocena).toBe(nicPoObuStronach[0].ocena);
    expect(ofertaBezWymiaru[0].ocena).toBe(nicPoObuStronach[0].ocena);
  });

  // ⚠️ SPRZECZNY ROZMIAR SCINA, ALE NIE WYRZUCA. Karta z innym wymiarem zostaje na liscie
  // — bo wymiar karty bywa niewpisany, wpisany z pomylka albo opisuje inny wariant tego
  // samego modelu. Kandydat schowany to kandydat, ktorego czlowiek nie ma jak poprawic.
  it('sprzeczny wymiar obniza ocene, ale kandydat ZOSTAJE na liscie', () => {
    const wynik = propozycje(oferta('Plafon okrągły 60x62 cm'), [
      karta(1, 'Plafon okrągły', 700, 1000),
    ]);

    expect(wynik).toHaveLength(1);
    expect(wynik[0].ocena).toBeGreaterThan(0);
    expect(wynik[0].ocena).toBeLessThan(1);
  });
});

describe('propozycje — remis rozstrzyga bogactwo wspolnych slow', () => {
  // ⚠️ Para z pomiaru: „ŁUK lampa podłogowa z marmurem" trafiala w sam „Łuk".
  // Tu jest ten sam uklad sprowadzony do remisu: obaj kandydaci maja IDENTYCZNE F1,
  // ale jeden dzieli z oferta cztery slowa, a drugi dwa. Cztery znacza wiecej.
  it('przy tej samej ocenie wygrywa kandydat z wieksza liczba wspolnych slow', () => {
    const karty = [
      // Dwa wspolne slowa z osmiu wlasnych → pokrycia 2/8 i 2/4.
      karta(1, 'Łuk marmurowy wielki biały'),
      // Cztery wspolne slowa z osmiu wlasnych → pokrycia 4/8 i 4/8.
      karta(2, 'Lampa podłogowa z marmurem - łuk stalowy salonowy czarny'),
    ];
    const wynik = propozycje(oferta('ŁUK lampa podłogowa z marmurem nowoczesna loftowa czarna'), karty);

    expect(wynik[0].karta.id).toBe(2);
    expect(wynik[0].wspolneSlowa.length).toBeGreaterThan(wynik[1].wspolneSlowa.length);
  });

  // ⚠️⚠️ DRUGA POLOWA PARY, I TO ONA PILNUJE KOLEJNOSCI KRYTERIOW. Liczba wspolnych slow
  // rozstrzyga WYLACZNIE remis — postawiona przed ocena robi z niej kryterium glowne,
  // a wtedy wygrywa kazda nazwa DLUGA: im wiecej slow ma karta, tym wieksza szansa, ze
  // trafi w kilka slow oferty, choc pokrycie ma marne. Tutaj oba kryteria wskazuja
  // PRZECIWNIE: kandydat trafny ma wyzsza ocene i MNIEJ wspolnych slow.
  //
  // (Zmierzone mutacja: sama zamiana kolejnosci tych dwoch linii, bez zmiany ani jednego
  // znaku ich tresci, przechodzila przez cala suite na zielono.)
  it('ocena bije liczbe wspolnych slow, gdy wskazuja przeciwnie', () => {
    const karty = [
      karta(1, 'Kopuła mosiężna'),
      karta(2, 'Kopuła mosiężna lampa wisząca nad stół jadalni kuchni salonu sypialni'),
    ];
    const wynik = propozycje(oferta('Kopuła mosiężna - lampa wisząca loftowa'), karty);

    expect(wynik[0].karta.id).toBe(1);
    // ...i wygral MIMO ze wspolnych slow ma mniej — bez tego zdania test przechodzilby
    // takze wtedy, gdyby oba kryteria wskazywaly to samo.
    expect(wynik[0].wspolneSlowa.length).toBeLessThan(wynik[1].wspolneSlowa.length);
    expect(wynik[0].ocena).toBeGreaterThan(wynik[1].ocena);
  });

  // Kolejnosc ma byc POWTARZALNA miedzy odswiezeniami: pelny remis (ta sama ocena i tyle
  // samo wspolnych slow) rozstrzyga nazwa, a dopiero na koncu identyfikator. Bez tego ten
  // sam ekran pokazywalby raz jednego, raz drugiego kandydata na pierwszym miejscu.
  it('pelny remis rozstrzyga sie powtarzalnie — po nazwie, potem po id', () => {
    const karty = [karta(9, 'Kopuła mosiężna'), karta(3, 'Kopuła mosiężna'), karta(7, 'Kopuła mała')];
    const a = propozycje(oferta('Kopuła mosiężna lampa'), karty);
    const b = propozycje(oferta('Kopuła mosiężna lampa'), [...karty].reverse());

    expect(a.map((p) => p.karta.id)).toEqual([3, 9, 7]);
    expect(b.map((p) => p.karta.id)).toEqual(a.map((p) => p.karta.id));
  });
});

describe('propozycje — ile kandydatow i kiedy zadnego', () => {
  it('domyslnie oddaje TRZECH najlepszych, nie wiecej', () => {
    const karty = [1, 2, 3, 4, 5].map((i) => karta(i, `Kopuła wariant ${i}`));
    expect(propozycje(oferta('Kopuła lampa'), karty)).toHaveLength(3);
    expect(propozycje(oferta('Kopuła lampa'), karty, { ile: 5 })).toHaveLength(5);
  });

  it('katalog bez kart oddaje pusto, a nie wyjatek', () => {
    expect(propozycje(oferta('Kopuła'), [])).toEqual([]);
    expect(propozycje(oferta('Kopuła'), null)).toEqual([]);
  });

  // ⚠️⚠️ TO JEDYNE ODRZUCENIE, JAKIE TU JEST — I NIE JEST PROGIEM JAKOSCI. Zmierzone:
  // przy najlepszej mierze tylko 10% ofert osiaga „pewne", a w kubelku 0,50–0,67 siedza
  // trafienia POPRAWNE. Prog na ocenie chowalby wiec prace, ktora trzeba wykonac.
  // Odrzucamy WYLACZNIE zero wspolnych slow: tam nie ma czego rankowac, a trzy przypadkowe
  // karty pod oferta to zaproszenie do klikniecia w cudza karte.
  it('zero wspolnych slow = brak propozycji; JEDNO wspolne slowo = propozycja JEST', () => {
    const karty = [karta(1, 'Kopuła mosiężna'), karta(2, 'Lampion')];

    expect(propozycje(oferta('Lampa stołowa'), karty)).toEqual([]);
    // Druga polowa pary: straznik ma MILCZEC, gdy jest cokolwiek wspolnego. Ocena bywa
    // niska i ma taka byc — od jej czytania jest czlowiek, nie warunek w kodzie.
    const jedno = propozycje(oferta('Kopuła lampa stołowa nocna duża'), karty);
    expect(jedno.map((p) => p.karta.id)).toEqual([1]);
    expect(jedno[0].ocena).toBeGreaterThan(0);
    expect(jedno[0].ocena).toBeLessThan(0.5);
  });

  it('oferta bez ani jednego slowa nie wywala liczenia', () => {
    for (const zla of ['', '   ', '- , -', null, undefined, 42]) {
      expect(propozycje({ nazwa: zla }, [karta(1, 'Kopuła')]), String(zla)).toEqual([]);
    }
  });

  it('karta bez nazwy jest pomijana, a reszta katalogu liczy sie dalej', () => {
    const karty = [{ id: 1, nazwa: null }, { id: 2 }, karta(3, 'Kopuła mosiężna')];
    expect(propozycje(oferta('Kopuła'), karty).map((p) => p.karta.id)).toEqual([3]);
  });
});

// ————————————————————————————————————————————————————————————————————————————————
// DRUGA STRONA TEJ SAMEJ REGULY.
//
// Ekran powiazan pyta „dla TEJ oferty — ktore karty?", karta produktu pyta „dla TEJ karty —
// ktore oferty?". To jest jedno i to samo pytanie o podobienstwo dwoch nazw, wiec ma na nie
// odpowiadac JEDNA funkcja. Druga kopia reguly rozjezdza sie z pierwsza przy pierwszej
// zmianie — a w tym module „rozjazd" znaczy, ze karta podsuwa inna oferte niz ekran obok.
describe('propozycje — miara jest SYMETRYCZNA takze przy rozmiarze', () => {
  // ⚠️⚠️ TO JEST TEST, KTORY WYMUSIL POPRAWKE W `zRozmiarem`. Wymiary jednej strony stoja
  // w KOLUMNACH (karta), drugiej w NAZWIE (oferta) — i przed poprawka funkcja szukala ich
  // po STRONIE, a nie po tym, gdzie sa. Zamiana stron gubila wiec rozstrzygajacy rozmiar:
  // ekran powiazan liczyl 63%, a karta tej samej pary 50%.
  it('ta sama para daje TE SAMA ocene niezaleznie od tego, ktora strone pytamy', () => {
    const w = karta(1, 'Kopuła', 700, 1000);
    const o = oferta('KOPUŁA mosiężna duża 70x100cm');

    const zeStronyOferty = propozycje(o, [w]);
    const zeStronyKarty = propozycje(w, [o]);

    expect(zeStronyOferty).toHaveLength(1);
    expect(zeStronyKarty).toHaveLength(1);
    expect(zeStronyKarty[0].ocena).toBe(zeStronyOferty[0].ocena);
    // I rozmiar NAPRAWDE tu rozstrzyga — inaczej ta rownosc bylaby rownoscia dwoch
    // liczb, ktorych zgodnosc wymiaru w ogole nie dotknela.
    expect(zeStronyOferty[0].ocena).toBeGreaterThan(
      propozycje(oferta('KOPUŁA mosiężna duża'), [karta(1, 'Kopuła', 700, 1000)])[0].ocena,
    );
  });

  // ⚠️ KOLUMNA BIJE NAZWE, i to nie jest szczegol implementacji. W sklepie B oba zrodla niosa
  // ROZNE, PRAWDZIWE liczby: „Lampa wisząca Kopuła – 60x62cm" ma atrybut „70 x 100 cm", bo
  // 60×62 to sam klosz, a 70×100 to produkt gotowy do wysylki (patrz domena/karta-z-produktu.js).
  // Magazyn trzyma w kolumnach wymiar z atrybutu — wpisany albo potwierdzony przez czlowieka — wiec to on
  // rozstrzyga, a nazwa jest tym, co udalo sie odczytac.
  it('wymiar Z KOLUMNY bije wymiar wyczytany z nazwy', () => {
    const w = { id: 1, nazwa: 'Kopuła 20x30cm', sku: null, szerokosc_mm: 700, wysokosc_mm: 1000 };

    const zgodnaZKolumna = propozycje(w, [oferta('KOPUŁA mosiężna duża 70x100cm')])[0].ocena;
    const zgodnaZNazwa = propozycje(w, [oferta('KOPUŁA mosiężna duża 20x30cm')])[0].ocena;

    expect(zgodnaZKolumna).toBeGreaterThan(zgodnaZNazwa);
  });

  it('rozmiar SPRZECZNY scina ocene tak samo z obu stron', () => {
    const w = karta(1, 'Kopuła', 700, 1000);
    const o = oferta('KOPUŁA mosiężna duża 20x30cm');

    expect(propozycje(w, [o])[0].ocena).toBe(propozycje(o, [w])[0].ocena);
    // Sciety, a nie WYRZUCONY: kandydat schowany to kandydat, ktorego czlowiek nie ma
    // jak poprawic (wymiar bywa niewpisany albo wpisany z pomylka).
    expect(propozycje(w, [o])).toHaveLength(1);
  });

  it('brak wymiaru po ktorejkolwiek stronie zostawia ocene nietknieta — z obu stron', () => {
    const w = karta(1, 'Kopuła');
    const o = oferta('KOPUŁA mosiężna duża 70x100cm');
    const bezRozmiaru = oferta('KOPUŁA mosiężna duża');

    expect(propozycje(w, [o])[0].ocena).toBe(propozycje(w, [bezRozmiaru])[0].ocena);
    expect(propozycje(w, [o])[0].ocena).toBe(propozycje(o, [w])[0].ocena);
  });

  it('`propozycjeOfert` to TA SAMA regula, tylko nazwana od strony karty', () => {
    const w = karta(1, 'Kopuła', 700, 1000);
    const oferty = [oferta('KOPUŁA mosiężna duża 70x100cm'), oferta('Lampion mosiężny')];

    const wynik = propozycjeOfert(w, oferty);

    expect(wynik.map((p) => p.oferta.nazwa)).toEqual(['KOPUŁA mosiężna duża 70x100cm']);
    // Ocena LICZONA TA SAMA droga — nie „podobna", tylko ta sama.
    expect(wynik[0].ocena).toBe(propozycje(w, oferty)[0].ocena);
    expect(wynik[0].wspolneSlowa).toEqual(propozycje(w, oferty)[0].wspolneSlowa);
  });
});
