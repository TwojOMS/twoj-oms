// Produkt z lustra sklepu → WZOR w naszym rejestrze. Dwie funkcje czyste i jedna decyzja:
// co staje sie wzorem (`powodPominiecia`) i co ten wzor niesie (`wzorZProduktu`).
//
// ⚠️ TO JEST OPERACJA MASOWA. Jedno klikniecie zaklada ~980 wzorow i nikt ich potem nie
// przeglada po jednym — pomylka w regule rozchodzi sie po calym rejestrze i wychodzi dopiero
// w Etapie 2, na wycietym szablonie. Stad trzy zasady, ktore trzymaja ten plik:
//   (1) NIGDY NIE ZGADUJEMY. Wymiar, ktorego nie da sie odczytac jednoznacznie, jest `null`
//       i wzor trafia na liste „bez wymiarow"; kategoria, ktorej nie potwierdza sam produkt,
//       jest `null` i wzor trafia na liste „bez kategorii". Oba braki uzupelnia sie hurtem.
//   (2) CZEGO NIE UMIEMY ZROBIC, TO MOWIMY WPROST. Produkt bez wzoru ma POWOD wypisany
//       na ekranie „pominiete", a nie cicha nieobecnosc w rejestrze.
//   (3) POJEDYNCZY POPSUTY WIERSZ NIE MA PRAWA WYWALIC PRZEBIEGU. Cale tworzenie idzie
//       w jednej transakcji, wiec wyjatek na 500. produkcie cofa takze 499 poprzednich.
import { wymiaryZTekstu, nazwaBezRozmiaru } from './rozmiar.js';
import { atrybutyWariantu, osiePodzialu, nazwaZOsiami } from './atrybuty-wariantu.js';
import { wymagajListyKanalow } from './lista-kanalow.js';
import { czyPozycjaPlaceholdera } from './indywidualne.js';

const napis = (x) => (typeof x === 'string' ? x.trim() : '');

/**
 * Kategorie produktu — nazwy, tak jak zapisal je odczyt sklepu (`kategorie_json`).
 *
 * ⚠️ POPSUTY JSON ODDAJE PUSTA LISTE, A NIE WYJATEK. Kolumna jest zwyklym TEXT-em, a lustro
 * bierze sie z cudzego API — ta sama ostroznosc, ktora w `db/magazyn.js` filtruje kategorie
 * przez `json_valid`, i z tego samego powodu: jedna popsuta wartosc nie ma prawa polozyc
 * ani listy, ani przebiegu zakladajacego ~980 wzorow.
 */
function kategorieProduktu(produkt) {
  try {
    const lista = JSON.parse(produkt?.kategorie_json ?? '[]');
    return Array.isArray(lista) ? lista.filter((n) => napis(n)) : [];
  } catch {
    return [];
  }
}

/**
 * Kategoria glowna wzoru. Kolejnosc zrodel: (1) Yoast, (2) jedyna kategoria produktu, (3) null.
 *
 * ⚠️ KROK (3) NIE MOZE BRZMIEC „WEZ PIERWSZA Z BRZEGU". Przy wielu kategoriach nie da sie
 * wiedziec, czy „Boho" bije „Farmhouse", a tej wartosci uzywa generator SKU — przypadkowy wybor
 * produkowalby przypadkowe numery katalogowe, cicho i nieodwracalnie. Zmierzone 2026-08-06:
 * Yoast wypelnia 104/104 na sklepie B i 608/668 na sklepie A, wiec do reki zostaja 54 decyzje.
 *
 * ⚠️ WARTOSC Z YOASTA MUSI BYC JEDNA Z KATEGORII TEGO PRODUKTU. Yoast trzyma IDENTYFIKATOR
 * terminu jako NAPIS („64"); na nazwe mapuje go `magazyn-sync`, ale gdy mapowanie sie nie uda
 * (kategoria skasowana, produkt przeniesiony miedzy sklepami), do kolumny nie ma prawa wpasc
 * ani surowy identyfikator, ani nazwa z innego katalogu. Sprawdzamy wiec PRZYNALEZNOSC, a nie
 * „czy to wyglada na liczbe": regula lapie wszystkie te przypadki naraz, a nie jeden z nich.
 */
function kategoriaGlowna(produkt) {
  const lista = kategorieProduktu(produkt);
  const zrodlowa = napis(produkt?.kategoria_glowna_zrodla);
  if (zrodlowa && lista.includes(zrodlowa)) return zrodlowa;
  if (lista.length === 1) return lista[0];
  return null;
}

// Nazwane encje, ktore realnie wychodza z `short_description` WooCommerce. Reszte lapie
// postac liczbowa nizej — polskie cudzyslowy i poltapzy Woo oddaje wlasnie tak (&#8222;).
const ENCJE = new Map([
  ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"], ['nbsp', ' '],
]);

/**
 * Encje → znaki, DOKLADNIE JEDNYM przebiegiem.
 *
 * ⚠️ JEDEN PRZEBIEG, NIE PETLA „dopoki sie zmienia". Podwojne rozwijanie zamienia „&amp;lt;"
 * w „<", czyli z tekstu, ktory sklep SWIADOMIE zapisal jako widoczny znacznik, robi znacznik.
 * To ten sam blad, ktory w cudzych systemach konczy sie wstrzyknieciem.
 *
 * ⚠️ Kod spoza Unicode wywala `String.fromCodePoint` RangeError-em. Zostawiamy wtedy tekst
 * nietkniety, bo jeden dziwny opis nie ma prawa cofnac transakcji z ~980 wstawieniami.
 */
function rozwinEncje(tekst) {
  return tekst.replace(/&(#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);/gu, (calosc, tresc) => {
    if (tresc[0] !== '#') return ENCJE.get(tresc.toLowerCase()) ?? calosc;
    const kod = tresc[1] === 'x' || tresc[1] === 'X'
      ? Number.parseInt(tresc.slice(2), 16)
      : Number.parseInt(tresc.slice(1), 10);
    // Zero, polowka pary zastepczej i kod ponad zakresem Unicode nie sa znakiem, ktory da sie
    // wpisac do kolumny TEXT — zostaja tekstem, bo tak przynajmniej widac, co przyszlo.
    if (!(kod >= 1 && kod <= 0x10FFFF) || (kod >= 0xD800 && kod <= 0xDFFF)) return calosc;
    return String.fromCodePoint(kod);
  });
}

/**
 * `short_description` ze sklepu → czysty tekst opisu wzoru.
 *
 * W Etapie 2 ta wartosc staje sie trescia pliku z opisem w folderze wzoru na NAS-ie, wiec
 * czyta ja czlowiek, a nie przegladarka — HTML jest tu smieciem, nie formatowaniem.
 *
 * ⚠️ ZNACZNIK ZAMIENIAMY NA SPACJE, NIE NA PUSTKE: „<p>a</p><p>b</p>" bez tego daje „ab",
 * czyli slowo, ktorego w sklepie nie bylo.
 *
 * ⚠️ KOLEJNOSC: najpierw znaczniki, potem encje. Odwrotnie „&lt;b&gt;" zamienialoby sie
 * najpierw w „<b>", a potem znikalo jako znacznik — czyli tekst, ktory sklep chcial POKAZAC,
 * gubilby sie po cichu.
 */
function opisZeSklepu(surowy) {
  if (typeof surowy !== 'string') return null;
  const tekst = rozwinEncje(surowy.replace(/<[^>]*>/gu, ' ')).replace(/\s+/gu, ' ').trim();
  // Pusty opis to `null`, nie pusty napis — kolumna ma mowic „nie wiem", a nie „wiem, ze nic".
  return tekst || null;
}

/**
 * Wymiary wzoru w milimetrach.
 *
 * ⚠️ ATRYBUT BIJE NAZWE I JEGO ODMOWA TEZ BIJE NAZWE. Na PRO oba niosa ROZNE, PRAWDZIWE liczby:
 * „Teren monitorowany – 60x62cm" ma atrybut „70 x 100 cm", bo 60×62 to WZOR, a 70×100 to ARKUSZ,
 * z ktorego sie go wycina. Magazyn trzyma wymiar ARKUSZA — to on decyduje o pakowaniu,
 * paczkomacie i cenie. Skoro wiec sklep WSKAZAL zrodlo rozmiaru, to nawet gdy tego wskazania
 * nie da sie odczytac („Zestaw 70x100 cm i 45x65 cm"), zejscie na nazwe podstawiloby wymiar
 * z INNEGO zrodla niz to, ktore sklep wskazal — i nikt by tego nie zauwazyl.
 *
 * Na nazwe schodzimy WYLACZNIE wtedy, gdy `rozmiar_tekst` jest pusty — czyli gdy sklep nie
 * wskazal niczego (produkty proste ze sklepu A: „Chmurka i Ksiezyc – aplikacja 30x48cm").
 */
function wymiary(produkt, nazwaZrodlowa) {
  const zAtrybutu = napis(produkt?.rozmiar_tekst);
  return wymiaryZTekstu(zAtrybutu || nazwaZrodlowa) ?? null;
}

/**
 * Produkt sklepowy → pola nowego wzoru, albo `null`, gdy wzoru zrobic sie nie da.
 *
 * `null` oddajemy DOKLADNIE W TYCH przypadkach, na ktore `powodPominiecia` ma powod — te dwie
 * funkcje sa jedna decyzja rozpisana na dwa pytania i nie wolno im sie rozjechac (patrz test
 * „to, czego wzorZProduktu nie umie zrobic, ma powod pominiecia").
 *
 * Ksztalt wyniku jest STALY — piec kluczy zawsze, brak jako `null`. `utworzWzor` pomija pola
 * `undefined`, wiec ksztalt zmienny znaczylby, ze raz zapisujemy kolumne, a raz nie, i to
 * zaleznie od danych sklepu.
 */
export function wzorZProduktu(produkt) {
  const zrodlowa = napis(produkt?.nazwa);
  if (!zrodlowa) return null;

  // Nazwa gubi dopisek z rozmiarem („Teren monitorowany – 60x62cm" → „Teren monitorowany”):
  // rozmiar jest osobna kolumna, a z nazwy korzysta lista i generator SKU. `nazwaBezRozmiaru`
  // nie tnie tego, czego nie rozpoznaje jednoznacznie — ta sama zasada, co przy wymiarach.
  const nazwa = napis(nazwaBezRozmiaru(zrodlowa)) || zrodlowa;
  const wymiar = wymiary(produkt, zrodlowa);

  return {
    // ⚠️ NAZWA NIESIE WARTOSC OSI PODZIALU — inaczej z `Woodland` powstaja trzy wzory
    // „Woodland", nierozroznialne na liscie i w generatorze SKU. Uzasadnienie w calosci
    // przy `nazwaZOsiami` w domain/atrybuty-wariantu.js.
    //
    // ⚠️ Wiersz, ktorego atrybutow lustro nie zna (`null`), dostaje nazwe DOKLADNIE taka jak
    // dotad — `?? []` jest tu swiadome: „nie wiemy" nie ma prawa niczego do nazwy dopisac.
    nazwa: nazwaZOsiami(nazwa, osiePodzialu(atrybutyWariantu(produkt) ?? [])),
    kategoria_glowna: kategoriaGlowna(produkt),
    opis: opisZeSklepu(produkt?.opis_zrodlowy),
    szerokosc_mm: wymiar?.szerokosc_mm ?? null,
    wysokosc_mm: wymiar?.wysokosc_mm ?? null,
  };
}

/**
 * Czy ta pominieta pozycja jest „tak ma byc" — czyli czy NIE MA przy niej nic do zrobienia.
 *
 * ⚠️⚠️ ROZSTRZYGA POZYCJA, NIE SAM KANAL, i to jest zmiana wobec stanu sprzed 2026-08-11.
 * Wczesniej „celowe" znaczylo dokladnie tyle, co „nie pochodzi z kanalu sklepowego" — czyli
 * w praktyce „to oferta Allegro". Pomiar na produkcyjnej bazie pokazal 13 pozycji ZE SKLEPU,
 * ktore wzorami nie beda NIGDY: `Projekt indywidualny` (12 wariantow rozniacych sie sama cena)
 * i zaslepke `psm-zam-placeholder`. Siedzialy na gorze ekranu jako robota i udawaly usterke,
 * ktorej naprawic sie nie da, bo nic tam nie jest zepsute.
 *
 * ⚠️ TRZY POWODY, NIE JEDEN OGOLNY WARUNEK. „Celowe" jest to, czego wlasciciel NIE MA JAK
 * poprawic — a nie to, czego panel nie umie przetworzyc. Wariant bez atrybutu i wariant
 * o nieznanych atrybutach zostaja ROBOTA, bo pierwszy poprawia sie w sklepie, a drugi jednym
 * klknieciem „Odczytaj katalogi".
 *
 * ⚠️ Ta funkcja mowi TYLKO o pozycjach, ktore juz odpadly (`powodPominiecia` niepuste). Dla
 * pozostalych jej wynik nie znaczy nic i nikt jej o nie nie pyta.
 */
export function czyPominietyCelowo(produkt, kanalySklepow) {
  wymagajListyKanalow(kanalySklepow);
  // Oferta Allegro (i kazdy kanal spoza bialej listy): wzor powstaje z katalogu sklepu,
  // a oferte wiaze sie z nim recznie. Nie ma tu czego naprawiac.
  if (!kanalySklepow.includes(napis(produkt?.kanal))) return true;

  // Zaslepka wtyczki panelu ofert — pozycja techniczna, nie wzor.
  if (czyPozycjaPlaceholdera(produkt?.sku_sklepu)) return true;

  // Wariant, ktorego JEDYNA osia podzialu jest cena: pozycja cennikowa, nie wzor.
  // ⚠️ `atrybuty === null` (lustro nie wie) NIE wpada tutaj — nieznane nie jest „tak ma byc".
  if (napis(produkt?.wariant_id) && !napis(produkt?.rozmiar_tekst)) {
    const atrybuty = atrybutyWariantu(produkt);
    if (atrybuty?.length && !osiePodzialu(atrybuty).length) return true;
  }

  return false;
}

/**
 * Dlaczego z tego produktu NIE robimy wzoru — napis dla czlowieka albo `null`, gdy robimy.
 *
 * ⚠️ KOLEJNOSC STRAZNIKOW JEST TRESCIA, NIE PORZADKIEM. Ten napis czyta wlasciciel na ekranie
 * „pominiete" i po nim decyduje, co zrobic; przy kilku powodach naraz ma paść ten NAJGLEBSZY.
 * Idziemy od „to nigdy nie bylo wzorem" do „to jest wzor, ale dane sa popsute". Oferta Allegro,
 * ktora zniknela, ma mowic o kanale — odsylanie wlasciciela do naprawy atrybutu w sklepie,
 * w ktorym tego produktu nigdy nie bylo, kosztowaloby go realne minuty razy kilkaset wierszy.
 */
export function powodPominiecia(produkt, kanalySklepow) {
  wymagajListyKanalow(kanalySklepow);
  const kanal = napis(produkt?.kanal);

  // ⚠️⚠️ OFERTA ALLEGRO NIE ZAKLADA WZORU — i to jest decyzja z rozpoznania, nie ostroznosc.
  // Spec §3: „z 1010 pozycji SKLEPOWYCH powstaje okolo 980 wzorow", a recznie zostaje
  // „podpiecie ofert Allegro", czyli zwiazanie oferty z wzorem, ktory powstal ze SKLEPU.
  // Gdyby oferta zakladala wlasny wzor, rejestr urosłby o ~447 duplikatow o nazwach
  // SPRZEDAZOWYCH („Zakaz palenia papierosow - DUZY szablon malarski do znakowania" obok
  // sklepowego „Zakaz palenia – 64cm") i nie byloby juz czego z czym wiazac. Automatu do
  // dopasowania nie ma i miec nie moze: `external` jest `null` na WSZYSTKICH ofertach obu kont.
  //
  // BIALA LISTA, nie „byle nie Allegro": kanal, ktorego nie znamy, tez nie zaklada wzorow.
  // Nierozpoznany kanal ma sie POKAZAC na liscie pominietych, a nie po cichu dosypac rejestrowi
  // kilkuset wierszy — ta sama zasada, co „filtr, ktorego nie rozumiemy, NIE POSZERZA zbioru".
  if (!kanalySklepow.includes(kanal)) {
    return `kanał „${kanal || '(brak)'}" nie zakłada wzorów — wzór powstaje z katalogu sklepu`
      + ` (${kanalySklepow.join(', ')}), a ofertę wiąże się z nim ręcznie`;
  }

  // Ukryty produkt, ktorym wtyczka panelu ofert wstawia pozycje indywidualna, wysylke
  // i realizacje priorytetowa. Wzorem nie jest i nigdy nie bedzie.
  if (czyPozycjaPlaceholdera(produkt?.sku_sklepu)) {
    return 'zaślepka panelu ofert indywidualnych — to nie jest wzór, tylko pozycja techniczna';
  }

  // Produkt wycofany ze sprzedazy. Wiersz zostaje w lustrze (powiazanie z wzorem ma przezyc
  // wycofanie), ale zakladanie NOWEGO wzoru dla czegos, czego w sklepie juz nie ma, doklada
  // rejestrowi wiersz bez zadnego zastosowania.
  //
  // ⚠️ W OBECNYM POTOKU TEN STRAZNIK JEST NIEOSIAGALNY i to jest zamierzone: obaj konsumenci
  // (`utworzWzoryZNiepowiazanych`, `produktyPominiete`) chodza po `niepowiazaneProdukty`,
  // ktore filtruje `zniknal_at IS NULL` juz w SQL-u. Ekran „pominiete" pokaze wiec CZTERY
  // powody, nie piec — kto szuka piatego, znalazl wlasnie ten. Straznik zostaje dla wolajacych
  // spoza tej petli i jest obrona w glab, nie martwym kodem: po zdjeciu filtru z SQL-a testy
  // Zadania 8 zostaja zielone (lapie go ta galaz), a czerwieni sie osobny test w magazyn-db.
  // Obie warstwy sa przypiete wlasnym testem — nie usuwac zadnej „bo druga wystarczy".
  if (napis(produkt?.zniknal_at)) {
    return `zniknął ze sklepu (${napis(produkt.zniknal_at)}) — wzoru dla wycofanego produktu nie zakładamy`;
  }

  // ⚠️ WARIANT BEZ ROZMIARU TO NIE JEST JEDNA SPRAWA, TYLKO CZTERY (zmierzone na produkcyjnej
  // bazie 2026-08-11, po pierwszym prawdziwym odczycie 1459 pozycji: 47 takich wierszy).
  // Do tego dnia wszystkie cztery wpadaly do jednego worka „wariant bez rozmiaru", wiec
  // 28 wzorow, ktore powstac MOGLY, nie powstawalo — a 13 pozycji, ktore wzorami nie beda
  // nigdy, siedzialo w „robocie" i udawalo usterke do naprawienia.
  //
  // ⚠️ Warunek dotyczy WYLACZNIE wariantow. Produkt PROSTY bez rozmiaru jest normalny — takich
  // jest ~588 i to jest praca do wykonania (uzupelnienie hurtem), a nie usterka do zgloszenia.
  if (napis(produkt?.wariant_id) && !napis(produkt?.rozmiar_tekst)) {
    const atrybuty = atrybutyWariantu(produkt);

    // ⚠️⚠️ „NIE WIEMY" NIE JEST „NIE MA". Kolumna `atrybuty_json` powstala 2026-08-11, a 1459
    // wierszy zapisanych wczesniej ma w niej NULL az do najblizszego odczytu katalogow.
    // Zalozenie wzorow z takich danych daloby 20 wzorow o nazwie „CYFRY wys. 90cm (Arial)",
    // nierozroznialnych i nieodwracalnie ponumerowanych; odeslanie wlasciciela do sklepu
    // kazaloby mu poprawiac katalog, ktory jest w porzadku. Panel mowi wiec, co ma zrobic SAM.
    if (atrybuty === null) {
      return 'lustro nie zna jeszcze atrybutów tego wariantu — kliknij „Odczytaj katalogi",'
        + ' żeby panel mógł rozstrzygnąć, czy to osobny wzór';
    }

    // ROZSTRZYGNIECIE WLASCICIELA: os podzialu INNA NIZ rozmiar i cena znaczy, ze sklep sam
    // wskazal, czym te warianty sie roznia — a skoro nie rozmiarem, to sa to ROZNE WZORY.
    // `Woodland` (wzor=Wiewiorka/Zajac/Los), `Sleepy Cat` i `Mickey` (uklad=...), oba `CYFRY`
    // (czcionka + cyfra). Nazwe rozroznia `wzorZProduktu` — patrz `nazwaZOsiami`.
    if (!osiePodzialu(atrybuty).length) {
      // Sama cena jako os podzialu: `Projekt indywidualny` (12 wariantow, 69–129 zl).
      // To nie jest wzor i nie bedzie — powod ma to mowic wprost, zeby ekran „pominiete"
      // odlozyl te pozycje do „tak ma byc", a nie trzymal jako robote do konca swiata.
      if (atrybuty.length) {
        return 'warianty różnią się wyłącznie ceną — to nie jest wzór w różnych rozmiarach,'
          + ' tylko pozycja cennikowa; wzoru z niej nie zakładamy';
      }
      // ZERO atrybutow: `Koła duże` i `X` (6 wariantow, ceny 79/99/119). Ceny SA tam
      // rozmiarami, ale panel nie ma czego przeczytac — a drabinka cenowa to dokladnie to
      // zgadywanie, ktorego zabrania zasada (1) tego pliku. Powod nazywa CZYNNOSC.
      return 'wariant bez atrybutu wariacyjnego — panel nie ma czego przeczytać; nazwij'
        + ' w sklepie atrybut („Rozmiar") i podaj w nim wartości rozmiarów zamiast samych cen';
    }
  }

  // `wzory.nazwa` jest NOT NULL, a `produkty_sklepowe.nazwa` przepuszcza pusty napis — bez tego
  // strażnika `utworzWzor` rzuca w polowie przebiegu i cofa cala transakcje.
  if (!napis(produkt?.nazwa)) return 'produkt bez nazwy — wzór nie ma po czym się nazywać';

  return null;
}
