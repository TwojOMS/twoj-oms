import { describe, it, expect } from 'vitest';
import { wymiaryZTekstu, nazwaBezRozmiaru, opisWymiarow } from '../../src/domena/rozmiar.js';

// Milimetry z bazy → napis dla czlowieka. Kolumna „Wymiary" w magazynie.
describe('opisWymiarow — milimetry z bazy na centymetry na ekranie', () => {
  it('typowy wymiar', () => {
    expect(opisWymiarow({ szerokosc_mm: 700, wysokosc_mm: 1000 })).toBe('70 × 100 cm');
    expect(opisWymiarow({ szerokosc_mm: 450, wysokosc_mm: 650 })).toBe('45 × 65 cm');
  });

  // Zaokraglenie do pelnych centymetrow zamienialoby 30,5 cm na 30 albo 31 — a ta
  // liczba jedzie do sklepu i do gabarytu paczki.
  it('polowka centymetra zostaje polowka, a nie zaokragla sie po cichu', () => {
    expect(opisWymiarow({ szerokosc_mm: 305, wysokosc_mm: 480 })).toBe('30.5 × 48 cm');
  });

  // ⚠️ POLOWICZNY WYMIAR TO NADAL BRAK WYMIAROW — ta sama regula, co w filtrze braków
  // (`db/magazyn.js`). Inaczej wiersz pokazywalby wymiar i JEDNOCZESNIE wpadal do filtru
  // „bez wymiarów", a to jest ekran, na ktorym te braki sie uzupelnia.
  it('brak ktoregokolwiek wymiaru daje null', () => {
    expect(opisWymiarow({ szerokosc_mm: 700, wysokosc_mm: null })).toBeNull();
    expect(opisWymiarow({ szerokosc_mm: null, wysokosc_mm: 1000 })).toBeNull();
    expect(opisWymiarow({})).toBeNull();
    expect(opisWymiarow(null)).toBeNull();
  });

  // Zero i smiec w kolumnie INTEGER nie sa wymiarem — kolumna jest nullowalna i przyjmie
  // co jej dadzą, a „0 × 100 cm" wygladaloby na prawdziwy wymiar.
  it('zero i wartosc nieliczbowa to brak, nie wymiar', () => {
    expect(opisWymiarow({ szerokosc_mm: 0, wysokosc_mm: 1000 })).toBeNull();
    expect(opisWymiarow({ szerokosc_mm: 'siedemset', wysokosc_mm: 1000 })).toBeNull();
    expect(opisWymiarow({ szerokosc_mm: -700, wysokosc_mm: 1000 })).toBeNull();
  });
});

describe('wymiaryZTekstu — kształty zmierzone na prawdziwych sklepach', () => {
  it('atrybut Rozmiar ze sklepu B: spacje wokół x, jednostka na końcu', () => {
    expect(wymiaryZTekstu('70 x 100 cm')).toEqual({ szerokosc_mm: 700, wysokosc_mm: 1000 });
    expect(wymiaryZTekstu('45 x 65 cm')).toEqual({ szerokosc_mm: 450, wysokosc_mm: 650 });
  });

  it('atrybut Rozmiar ze sklepu A: bez spacji', () => {
    expect(wymiaryZTekstu('80x150cm')).toEqual({ szerokosc_mm: 800, wysokosc_mm: 1500 });
  });

  it('rozmiar w nazwie produktu, po myślniku', () => {
    expect(wymiaryZTekstu('Lampa wisząca Kopuła – 60x62cm'))
      .toEqual({ szerokosc_mm: 600, wysokosc_mm: 620 });
  });

  it('znak razy (×) działa tak samo jak litera x', () => {
    expect(wymiaryZTekstu('70 × 100 cm')).toEqual({ szerokosc_mm: 700, wysokosc_mm: 1000 });
  });

  it('milimetry rozpoznaje po jednostce, nie przelicza ich drugi raz', () => {
    expect(wymiaryZTekstu('700x1000 mm')).toEqual({ szerokosc_mm: 700, wysokosc_mm: 1000 });
  });

  it('ułamek dziesiętny z przecinkiem', () => {
    expect(wymiaryZTekstu('10,5 x 20 cm')).toEqual({ szerokosc_mm: 105, wysokosc_mm: 200 });
  });

  // Mutacja z Kroku 5 (Math.round -> Math.floor) przezyla oryginalne 11 testow: 10,5cm
  // mnozy sie czysto przez 10 (105.0), wiec zaokraglenie w dol dawalo ten sam wynik.
  // 12,25cm*10 = 122.5 — dopiero tu round i floor sie rozjezdzaja.
  it('zaokrągla w górę przy dokładnie połówce milimetra', () => {
    expect(wymiaryZTekstu('12,25 x 20 cm')).toEqual({ szerokosc_mm: 123, wysokosc_mm: 200 });
  });

  // ⚠️ SEDNO TEJ FUNKCJI. Wymiar zgadnięty jest GORSZY niż brak wymiaru, bo decyduje
  // o gabarycie paczki i o wymiarze pokazanym w sklepie.
  it('nigdy nie zgaduje: brak rozmiaru daje null', () => {
    expect(wymiaryZTekstu('Abażur lniany')).toBe(null);
    expect(wymiaryZTekstu('Geometryczne')).toBe(null);
    expect(wymiaryZTekstu('')).toBe(null);
    expect(wymiaryZTekstu(null)).toBe(null);
    expect(wymiaryZTekstu(undefined)).toBe(null);
  });

  it('nigdy nie zgaduje: dwa różne rozmiary w jednym napisie dają null', () => {
    expect(wymiaryZTekstu('Zestaw 70x100 cm i 45x65 cm')).toBe(null);
  });

  it('nigdy nie zgaduje: liczba bez drugiej liczby to nie rozmiar', () => {
    expect(wymiaryZTekstu('KLOSZ wys. 50cm (opal)')).toBe(null);
    expect(wymiaryZTekstu('Abażur 80cm')).toBe(null);
  });

  it('nigdy nie zgaduje: bez jednostki nie wiadomo, czy to cm czy mm', () => {
    expect(wymiaryZTekstu('70x100')).toBe(null);
  });

  it('zero i wartości ujemne to nie rozmiar', () => {
    expect(wymiaryZTekstu('0 x 100 cm')).toBe(null);
  });

  // Mutacja z Kroku 5 (usuniecie \b po jednostce) przezyla oryginalne 11 testow: „cm"
  // dopasowywalo sie tez jako prefiks dluzszego slowa/liczby, np. skrótu powierzchni.
  it('jednostka musi kończyć się granicą słowa: „cm" wewnątrz dłuższego ciągu to nie rozmiar', () => {
    expect(wymiaryZTekstu('70x100cm2')).toBe(null);
    expect(wymiaryZTekstu('70x100 cm2')).toBe(null);
  });
});

describe('nazwaBezRozmiaru — usuwa rozmiar z nazwy produktu, nigdy nie zgaduje', () => {
  it('usuwa rozmiar razem z osieroconym myślnikiem', () => {
    expect(nazwaBezRozmiaru('Lampa wisząca Kopuła – 60x62cm')).toBe('Lampa wisząca Kopuła');
    expect(nazwaBezRozmiaru('Kopuła - 70 x 100 cm')).toBe('Kopuła');
  });

  // Gdy rozmiar jest PIERWSZYM segmentem, myślnik po nim (dywiz albo pauza) nie ma
  // z lewej strony niczego do rozdzielania — jest tak samo osierocony jak myślnik
  // PRZED rozmiarem w odwrotnym układzie, więc też musi zniknąć.
  it('rozmiar jako pierwszy segment: osierocony myślnik po nim znika razem z rozmiarem', () => {
    expect(nazwaBezRozmiaru('70x100cm - Kopuła')).toBe('Kopuła');
    expect(nazwaBezRozmiaru('60x62cm – Kopuła')).toBe('Kopuła');
  });

  it('nazwa bez rozmiaru wraca bez zmian', () => {
    expect(nazwaBezRozmiaru('Abażur lniany')).toBe('Abażur lniany');
    expect(nazwaBezRozmiaru('Geometryczne')).toBe('Geometryczne');
  });

  it('nazwa złożona z samego rozmiaru NIE staje się pusta — zostaje oryginał', () => {
    expect(nazwaBezRozmiaru('60x62cm')).toBe('60x62cm');
    expect(nazwaBezRozmiaru('  70 x 100 cm  ')).toBe('  70 x 100 cm  ');
  });

  it('pojedynczej liczby nie rusza', () => {
    expect(nazwaBezRozmiaru('Abażur 80cm')).toBe('Abażur 80cm');
    expect(nazwaBezRozmiaru('KLOSZ wys. 50cm (opal)')).toBe('KLOSZ wys. 50cm (opal)');
  });

  it('nigdy nie zgaduje: dwa różne rozmiary w jednym napisie zostają nietknięte', () => {
    expect(nazwaBezRozmiaru('Zestaw 70x100 cm i 45x65 cm')).toBe('Zestaw 70x100 cm i 45x65 cm');
  });

  it('rozmiar w środku nazwy znika razem z nadmiarową spacją, reszta zdania zostaje', () => {
    expect(nazwaBezRozmiaru('Rozmiar – 60x62cm – wersja premium')).toBe('Rozmiar – wersja premium');
  });

  // Poprzednia poprawka czyściła prawą stronę TYLKO gdy lewa wyszła pusta — więc
  // myślnik osierocony na PRAWYM końcu (gdy lewy segment i tak istnieje) zostawał
  // wiszący: 'Kopuła - 70x100cm -' dawało 'Kopuła -' zamiast 'Kopuła'. Sprawdzamy
  // oba znaki myślnika, żeby nie odtworzyć tej samej asymetrii pod inną postacią.
  it('myślnik osierocony na PRAWYM końcu znika, nawet gdy lewy segment istnieje', () => {
    expect(nazwaBezRozmiaru('Kopuła - 70x100cm -')).toBe('Kopuła');
    expect(nazwaBezRozmiaru('Kopuła – 70x100cm –')).toBe('Kopuła');
  });

  it('wejście inne niż string wraca bez zmian', () => {
    expect(nazwaBezRozmiaru(null)).toBe(null);
    expect(nazwaBezRozmiaru(undefined)).toBe(undefined);
  });

  // Kontrakt brzmi „string → string", ale dla wejscia nie-string funkcja oddaje TO SAMO
  // wejscie, a nie jego tekstowa postac — i to jest zamierzone. String(60) dalby '60',
  // czyli wiarygodnie wygladajaca nazwe karty, ktora zamaskowalaby blad wyzej (numer SKU
  // wpuszczony tam, gdzie mial isc tytul produktu). Oddany bez zmiany numer zostaje
  // numerem i pierwszy zapis do magazynu sie o niego potknie. `null`/`undefined` juz tak
  // dzialaly — reszta typow nie moze zachowywac sie inaczej niz one.
  it('wejście nie-string innego typu tez wraca IDENTYCZNE, nie skonwertowane na tekst', () => {
    expect(nazwaBezRozmiaru(60)).toBe(60);
    expect(nazwaBezRozmiaru(0)).toBe(0);

    const obiekt = { nazwa: 'Kopuła 70x100cm' };
    expect(nazwaBezRozmiaru(obiekt)).toBe(obiekt);

    const tablica = ['Kopuła 70x100cm'];
    expect(nazwaBezRozmiaru(tablica)).toBe(tablica);

    // Ta sama decyzja po obu stronach modulu: skoro nazwa nie-string nie jest tekstem,
    // to nie ma tez wymiarow — zaden typ nie wchodzi bocznymi drzwiami przez koercje.
    expect(wymiaryZTekstu(60)).toBe(null);
    expect(wymiaryZTekstu(['70x100cm'])).toBe(null);
  });
});

// Trzy recenzje z rzedu wywrocily sie na TEJ SAMEJ rodzinie bledu: nazwa byla skladana
// z dwoch kawalkow, a o spoiwie decydowala tylko JEDNA strona (albo dopiero brzegi
// gotowego napisu). Ponizsze przypadki opisuja obie strony osobno, zeby kazda kolejna
// proba „doczyszczenia brzegow" od razu tu padla.
describe('nazwaBezRozmiaru — spoiwo miedzy segmentami i brzegi nazwy', () => {
  // Rozmiar zjada separatory tylko z tej krawedzi, do ktorej PRZYLEGAL. Jesli po obu
  // stronach cos zostalo, wraca dokladnie jeden separator — ten, ktory naprawde byl
  // w oryginale, niezaleznie od tego, po ktorej stronie rozmiaru stal.
  it('separator miedzy segmentami przezywa, gdy stal tylko po LEWEJ stronie rozmiaru', () => {
    expect(nazwaBezRozmiaru('Kopuła - 70x100cm Premium')).toBe('Kopuła - Premium');
    expect(nazwaBezRozmiaru('Kopuła – 70x100cm Premium')).toBe('Kopuła – Premium');
  });

  it('separator miedzy segmentami przezywa, gdy stal tylko po PRAWEJ stronie rozmiaru', () => {
    expect(nazwaBezRozmiaru('Kopuła 70x100cm - Premium')).toBe('Kopuła - Premium');
  });

  it('gdy separator byl po obu stronach, zostaje dokladnie jeden', () => {
    expect(nazwaBezRozmiaru('Rozmiar – 60x62cm – wersja premium')).toBe('Rozmiar – wersja premium');
    expect(nazwaBezRozmiaru('Kopuła - 70x100cm - Premium')).toBe('Kopuła - Premium');
  });

  it('gdy separatorem byla sama spacja, zostaje spacja — nie znika i nie awansuje na myslnik', () => {
    expect(nazwaBezRozmiaru('Kopuła 70x100cm Premium')).toBe('Kopuła Premium');
  });

  // Regula „przy remisie wygrywa lewa strona" byla dotad wylacznie deklaracja w komentarzu:
  // w zadnym tescie obie strony rozmiaru nie nosily RÓZNYCH mocnych znakow, wiec zamiana
  // kolejnosci warunku przechodzila cala suite. Tutaj lewa niesie przecinek, prawa myslnik —
  // wynik rozstrzyga, ktora strona wygrywa, i nie da sie go dostac z odwrotna kolejnoscia.
  it('gdy KAZDA strona niesie INNY mocny znak, wygrywa lewa — czytamy nazwe od lewej', () => {
    expect(nazwaBezRozmiaru('Kopuła, 70x100cm - Premium')).toBe('Kopuła, Premium');
    expect(nazwaBezRozmiaru('Kopuła - 70x100cm, Premium')).toBe('Kopuła - Premium');
  });

  // ZEWNETRZNE krawedzie nazwy nie sa nasza sprawa. Ta sama nazwa nie moze tracic
  // wiodacego znaku tylko dlatego, ze niesie rozmiar.
  it('wiodacy myslnik nalezacy do nazwy zostaje, tak samo z rozmiarem jak i bez', () => {
    expect(nazwaBezRozmiaru('- Kopuła')).toBe('- Kopuła');
    expect(nazwaBezRozmiaru('- Kopuła 70x100cm')).toBe('- Kopuła');
  });

  it('koncowy myslnik nalezacy do nazwy zostaje, tak samo z rozmiarem jak i bez', () => {
    expect(nazwaBezRozmiaru('Kopuła -')).toBe('Kopuła -');
    expect(nazwaBezRozmiaru('70x100cm Kopuła -')).toBe('Kopuła -');
  });

  // Nawias i przecinek to takie samo spoiwo jak myslnik — po wycieciu rozmiaru nie moga
  // zostac osierocone. Nawias, ktory OPAKOWYWAL rozmiar, znika razem z nim.
  it('nawias opakowujacy rozmiar znika razem z rozmiarem', () => {
    expect(nazwaBezRozmiaru('Lampa wisząca Kopuła (60x62cm)')).toBe('Lampa wisząca Kopuła');
    expect(nazwaBezRozmiaru('Lampa wisząca Kopuła (60x62cm) premium')).toBe('Lampa wisząca Kopuła premium');
  });

  it('przecinek przed rozmiarem nie zostaje osierocony na koncu nazwy', () => {
    expect(nazwaBezRozmiaru('Kopuła, 70x100cm')).toBe('Kopuła');
    expect(nazwaBezRozmiaru('Kopuła, 70x100cm, premium')).toBe('Kopuła, premium');
  });

  // Obie funkcje musza dzielic JEDNA decyzje o tym, co jest rozmiarem. Napis, ktoremu
  // wymiaryZTekstu odmawia wymiarow, nie moze stracic ani znaku w nazwie — inaczej karta
  // trafia na liste „bez wymiarow" z nazwa okrojona o cos, czego nikt nie rozpoznal.
  it('to, czego wymiaryZTekstu nie uznaje za rozmiar, zostaje w nazwie (rozmiar zerowy)', () => {
    expect(wymiaryZTekstu('Kopuła - 0 x 100 cm')).toBe(null);
    expect(nazwaBezRozmiaru('Kopuła - 0 x 100 cm')).toBe('Kopuła - 0 x 100 cm');
  });

  it('to, czego wymiaryZTekstu nie uznaje za rozmiar, zostaje w nazwie (zaokraglenie do zera)', () => {
    expect(wymiaryZTekstu('Kopuła - 0,04 x 100 mm')).toBe(null);
    expect(nazwaBezRozmiaru('Kopuła - 0,04 x 100 mm')).toBe('Kopuła - 0,04 x 100 mm');
  });

  it('to, czego wymiaryZTekstu nie uznaje za rozmiar, zostaje w nazwie (jednostka w dluzszym slowie)', () => {
    expect(wymiaryZTekstu('Kopuła - 70x100cm2')).toBe(null);
    expect(nazwaBezRozmiaru('Kopuła - 70x100cm2')).toBe('Kopuła - 70x100cm2');
  });

  // ⚠️ TO JEST STRAZNIK REGRESJI, NIE ZABOJCA MUTACJI — i tak ma zostac odczytany.
  // Ten test przeszedlby rowniez na wspoldzielonej stalej z flaga `g`, bo `matchAll`
  // species-konstruuje KOPIE regexpu i `lastIndex` oryginalu nigdy sie nie rusza. Zaden
  // test czarnoskrzynkowy nie ugryzie tu mocniej: przy dzisiejszej implementacji roznica
  // miedzy stala a fabryka jest NIEOBSERWOWALNA z zewnatrz. Wartosc tego testu jest inna
  // i realna: pilnuje momentu, w ktorym ktos zamieni `matchAll` na `.test()`/`.exec()` —
  // wtedy stan zaczyna wyciekac miedzy wywolaniami i co drugie pytanie o ten sam napis
  // oddaje inny wynik. Za sama fabryke odpowiada komentarz przy `wzorzecRozmiaru`.
  it('powtorzone wywolania na tym samym napisie daja ten sam wynik', () => {
    for (let i = 0; i < 3; i += 1) {
      expect(wymiaryZTekstu('70 x 100 cm')).toEqual({ szerokosc_mm: 700, wysokosc_mm: 1000 });
      expect(nazwaBezRozmiaru('Kopuła - 70 x 100 cm')).toBe('Kopuła');
    }
  });
});

// Poprzednia runda dolozyla nawiasy do klasy spoiwa i obcinala je BEZWARUNKOWO — a nawias
// nie jest separatorem, tylko polowa pary. Skutkiem byly nazwy z niesparowanym znakiem
// („Lampa wisząca Kopuła (zolta"), bo kod zjadal nawias, ktory nie mial z rozmiarem nic
// wspolnego. Ksztalt „nazwa (kolor/material) + rozmiar" JEST w prawdziwych danych — wlasny
// test suity uzywa 'KLOSZ wys. 50cm (opal)', ksztaltu przepisanego ze sklepu. Ponizsze przypadki
// opisuja obie strony osobno i obie role nawiasu: opakowanie rozmiaru i czesc nazwy.
describe('nazwaBezRozmiaru — nawias jest PARA, nie separatorem', () => {
  it('nawias wokol czegos INNEGO niz rozmiar zostaje nietkniety (nawias po lewej od rozmiaru)', () => {
    expect(nazwaBezRozmiaru('Lampa wisząca Kopuła (żółta) – 60x62cm')).toBe('Lampa wisząca Kopuła (żółta)');
    expect(nazwaBezRozmiaru('Kopuła [PROMOCJA] 70x100cm')).toBe('Kopuła [PROMOCJA]');
    expect(nazwaBezRozmiaru('Kopuła (duża) 70x100cm Premium')).toBe('Kopuła (duża) Premium');
  });

  it('nawias wokol czegos INNEGO niz rozmiar zostaje nietkniety (nawias po prawej od rozmiaru)', () => {
    expect(nazwaBezRozmiaru('KLOSZ 70x100cm (opal)')).toBe('KLOSZ (opal)');
    expect(nazwaBezRozmiaru('70x100cm (opal) Kopuła')).toBe('(opal) Kopuła');
    expect(nazwaBezRozmiaru('Kopuła 70x100cm (opal) Premium')).toBe('Kopuła (opal) Premium');
  });

  // Druga rola nawiasu — ta, dla ktorej w ogole trafil do kodu. Znika CALA para, bo
  // opakowywala wylacznie rozmiar i bez niego nie ma czego opakowywac.
  it('nawias opakowujacy rozmiar znika w calosci — kazdy rodzaj nawiasu', () => {
    expect(nazwaBezRozmiaru('Kopuła [70x100cm] Premium')).toBe('Kopuła Premium');
    expect(nazwaBezRozmiaru('Kopuła {70x100cm}')).toBe('Kopuła');
    expect(nazwaBezRozmiaru('Kopuła (70 x 100 cm) Premium')).toBe('Kopuła Premium');
  });

  // Nawias bez pary nalezy do nazwy — kod nie ma prawa „poprawiac" zapisu sklepikarza,
  // ma tylko wyciac rozmiar. Wynik jest dokladnie tym, co zostaje po usunieciu samego
  // rozmiaru z napisu.
  it('niesparowany nawias otwierajacy nalezy do nazwy i zostaje', () => {
    expect(nazwaBezRozmiaru('Zestaw (70x100cm')).toBe('Zestaw (');
    expect(nazwaBezRozmiaru('Kopuła (70x100cm bez domkniecia')).toBe('Kopuła ( bez domkniecia');
  });

  it('nawiasy NIEPASUJACE do siebie to nie para — obie polowki zostaja', () => {
    expect(nazwaBezRozmiaru('Kopuła [70x100cm) Premium')).toBe('Kopuła [) Premium');
  });

  // Sub-przypadek: para nawiasow byla JEDYNYM podzialem miedzy czlonami. Nawias nie moze
  // wrocic jako spoiwo (dalby 'Kopuła(Premium' — znowu niesparowany znak), ale PODZIAL,
  // ktory niosl, musi przezyc — inaczej dwa czlony zlepiaja sie w jedno slowo i powstaje
  // nazwa, ktorej w sklepie nigdy nie bylo. Ten sam uklad na myslniku daje 'Kopuła-Premium',
  // wiec wersja nawiasowa nie moze byc jedynym miejscem, gdzie podzial ginie.
  it('para nawiasow bedaca jedynym podzialem zostawia po sobie spacje, nie zlepia czlonow', () => {
    expect(nazwaBezRozmiaru('Kopuła(70x100cm)Premium')).toBe('Kopuła Premium');
    expect(nazwaBezRozmiaru('Kopuła-70x100cm-Premium')).toBe('Kopuła-Premium');
    expect(nazwaBezRozmiaru('Kopuła (70x100cm)Premium')).toBe('Kopuła Premium');
  });

  // Mocny znak stojacy PRZED nawiasem opakowujacym nadal jest spoiwem — usuwamy nawias,
  // nie caly kontekst.
  it('mocny znak przed nawiasem opakowujacym przezywa jego usuniecie', () => {
    expect(nazwaBezRozmiaru('Kopuła - (70x100cm) Premium')).toBe('Kopuła - Premium');
    expect(nazwaBezRozmiaru('Kopuła (70x100cm) - Premium')).toBe('Kopuła - Premium');
  });
});

// Runda 6: gdy nawias mial biale znaki po OBU swoich stronach, zdjecie samego znaku
// nawiasu (albo pary myslnik+spacja) sklejalo dwie sasiadujace spacje w jedno
// DWUZNAKOWE „spoiwo" — lamiac wlasny kontrakt funkcji „wraca DOKLADNIE JEDEN
// separator". Ten sam brak normalizacji wystepowal rowniez bez zadnego nawiasu,
// przy samej wielokrotnej spacji dookola rozmiaru.
describe('nazwaBezRozmiaru — spoiwo zwija wielokrotne biale znaki do jednego', () => {
  it('nawias ze spacjami po OBU stronach nie zostawia podwojnej spacji w spoiwie', () => {
    expect(nazwaBezRozmiaru('Kopuła ( 70x100cm ) Premium')).toBe('Kopuła Premium');
    expect(nazwaBezRozmiaru('Kopuła - ( 70x100cm ) Premium')).toBe('Kopuła - Premium');
    expect(nazwaBezRozmiaru('Kopuła(70x100cm ) B')).toBe('Kopuła B');
  });

  it('sama wielokrotna spacja dookola rozmiaru (bez nawiasu) tez zwija sie do jednego spoiwa', () => {
    expect(nazwaBezRozmiaru('Kopuła  70x100cm  Premium')).toBe('Kopuła Premium');
  });

  // Zwijamy WYLACZNIE spoiwo, ktore funkcja sama sklada miedzy przetrwalymi segmentami
  // (`lewy`/`prawy` zostaja nietkniete). Wielokrotna spacja, ktora byla CZESCIA nazwy
  // POZA spoiwem, nie ma z separatorem rozmiaru nic wspolnego — nie wolno jej zwijac.
  it('wielokrotna spacja bedaca CZESCIA nazwy (poza spoiwem) zostaje nietknieta', () => {
    expect(nazwaBezRozmiaru('Kopuła  duża 70x100cm')).toBe('Kopuła  duża');
    expect(nazwaBezRozmiaru('Kopuła  duża')).toBe('Kopuła  duża');
  });
});
