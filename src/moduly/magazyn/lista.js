// Port frozen 5b9cd765: 890–1074.
import { stanyKart } from '../../oms/db/stany-magazynowe.js';
import { fmtDataCzas } from '../../domena/format-daty.js';

export function registerListaMagazynu(app, { db, magazyn, sklepy, pomoc, karta }) {
  const { kartyZKanalami, kategorieDoFiltra, SORTOWANIE_KART, zliczeniaBrakow, zliczeniaNiepowiazanych, filtryZZapytania, saJakiesFiltry, parametryUkryte, wartosciPol, adresMagazynu, PACZKOMAT_DO_FILTRA, PACZKOMAT_ETYKIETY, POLA_FORMULARZA_FILTROW, NAGLOWKI_KANALOW, BEZ_SKLEPOW, opisPrzebiegu, linkiSortowania, kafleBrakow, wierszKarty, ileKart, opisZawezenia, zWroc } = pomoc;
  app.get('/magazyn', async (req, reply) => {
    if (!magazyn) return reply.view('pusta-strona.ejs', BEZ_SKLEPOW);

    // ⚠️ BIALA LISTA, nie `SORTOWANIE[x] ?? domyslne`. Ta druga postac oddaje funkcje
    // z `Object.prototype` przy `?sort=constructor` i konczy sie pieciusetka na glownym
    // ekranie — zlapane przy Zadaniu 4. Lista jest TA SAMA, ktorej uzywa zapytanie
    // (`SORTOWANIE_KART` z db/magazyn.js), a `Set.has` nie zaglada do prototypu.
    const dozwolone = new Set(SORTOWANIE_KART);
    const sort = dozwolone.has(req.query.sort) ? req.query.sort : 'nazwa';
    // Nierozpoznany kierunek WRACA DO ROSNACEGO, a nie odmawia: kolejnosc nie zawęża
    // zbioru, wiec literowka w adresie ma pokazac liste, a nie pusty ekran.
    const kier = String(req.query.kier ?? '').toLowerCase() === 'desc' ? 'desc' : 'asc';

    // ⚠️ TE SAME BIALE LISTY, CO PRZY SORTOWANIU, tylko z INNYM zachowaniem przy nietrafieniu:
    // nierozpoznana nazwa filtru spada do `null` („nie zawezaj"), bo przepuszczona dalej
    // oddalaby pusty ekran bez slowa wyjasnienia. Cala regula siedzi w domenie.
    const filtry = filtryZZapytania(req.query);

    // ——— „ZAZNACZ WSZYSTKIE" BEZ JAVASCRIPTU ———
    // Stan pol wyboru chodzi ADRESEM, dokladnie tak samo, jak na liscie zamowien. Adres
    // USTAWIA stan poczatkowy przy renderze i na tym konczy sie jego rola: po zaladowaniu
    // strony to przegladarka pamieta, co jest odhaczone, a formularz wysyla przy zatwierdzeniu
    // stan pol Z TEJ CHWILI. Dzieki temu „zaznacz wszystkie, odhacz trzy, wykonaj na reszcie"
    // dziala bez ani jednej linii skryptu — i to jest cala roznica miedzy tym mechanizmem
    // a przyciskiem „dla wszystkich pasujacych", ktory jest CALY-ALBO-NIC.
    // ⚠️ Nierozpoznana wartosc NIE zaznacza (`=== '1'`, a nie „cokolwiek prawdziwego") —
    // to samo rozstrzygniecie, co przy zakresie akcji: czego panel nie rozumie, to znaczy
    // zbior WEZSZY, nigdy szerszy.
    const zaznaczWszystkie = String(req.query?.zaznacz ?? '') === '1';

    // ——— TRYB KOLUMN TABELI ———
    // ⚠️ BIALA LISTA DWOCH WARTOSCI, nieznana WRACA DO DOMYSLNEJ — tak samo jak kolejnosc,
    // a INACZEJ niz filtr (ten nierozpoznany oddaje pusto). Tryb nie zawęża zbioru, wiec
    // literowka w adresie ma pokazac liste w domyslnym ukladzie, a nie pusty ekran.
    // ⚠️ Porownanie do napisu, a nie `MAPA[x] ?? domyslne`: przy `?widok=constructor` ta
    // druga postac oddaje funkcje z `Object.prototype`, a przy powtorzonym parametrze
    // Fastify daje TABLICE — jedno i drugie odpada tutaj samo.
    const widok = req.query.widok === 'katalog' ? 'katalog' : 'porzadki';

    // Sortowanie i tryb kolumn NIE SA filtrami, ale jada tymi samymi formularzami: bez tych
    // pol klikniecie „Filtruj" na liscie ulozonej po wymiarze wracaloby do kolejnosci
    // domyslnej, a w trybie katalogowym — takze do kolumn porzadkow (niezmiennik 4.13b).
    // ⚠️ Tryb domyslny NIE jedzie ukrytym polem, tak samo jak nie wchodzi do adresu:
    // „/magazyn" i „/magazyn?widok=porzadki" maja zostac jednym adresem jednej rzeczy.
    const stanUkryty = [
      { name: 'sort', value: sort }, { name: 'kier', value: kier },
      ...(widok === 'katalog' ? [{ name: 'widok', value: 'katalog' }] : []),
    ];

    // ⚠️ JEDEN ODCZYT NA CALY EKRAN. Liczba „pasujacych do zawezenia" w pasku hurtu MUSI byc
    // liczona TYM SAMYM zapytaniem, co lista — druga droga do tej liczby rozjechalaby sie
    // z pierwsza po cichu i czlowiek klikalby „ustaw 645", dotykajac innego zbioru.
    const znalezione = kartyZKanalami(db, { fraza: filtry.fraza, filtry, sort, kier });

    // ⚠️ LICZONE PO CALYM KATALOGU, NIE PO `znalezione` — kafel odpowiada na pytanie „ile
    // roboty zostalo" i sam jest odnosnikiem, ktory to zawezenie ustawia (patrz zliczeniaBrakow).
    const zliczenia = zliczeniaBrakow(db);

    // Adres TEJ listy (Zadanie 6) — to on jedzie dalej jako `wroc` przy KAZDEJ karcie, ktora
    // z niej linkuje, zeby „Wróć do magazynu" trafil tu, a nie na zawsze goly „/magazyn".
    // ⚠️ BEZ `zaznacz`: stan pol wyboru nie ma sensu jako miejsce powrotu (checkbox jest
    // stanem PRZEGLADARKI po zaladowaniu strony, nie czyms, co adres ma odtwarzac).
    const adresPowrotuListy = adresMagazynu(filtry, { sort, kier, widok });

    // PRZ-091: stany magazynowe — wylacznie przy wlaczonym przelaczniku (Ustawienia → Magazyn). Wylaczone:
    // `stany.wlaczone === false`, kolumny i paska nie ma, ekran jak przed PRZ-091.
    const stany = stanyKart(db);
    const naStanie = (id) => (stany.wlaczone ? (stany.stany.get(Number(id))?.stan ?? 0) : null);
    const naMinusie = stany.wlaczone ? [...stany.stany.values()].filter((s) => s.stan < 0).length : 0;

    return reply.view('magazyn-lista.ejs', {
      title: 'Magazyn',
      // Dwa ekrany obok („pominiete" i powiazania) dostaja adres TEJ listy tak samo, jak
      // dostaje go kazdy ekran karty (4.13d) — gotowy z trasy, bo w tym module odnosniki
      // sklada trasa, a nie widok.
      //
      // ⚠️ ZAWSZE, takze przy liscie bez filtrow: `adresPowrotuListy` niesie rowniez
      // kolejnosc i tryb kolumn, wiec NIGDY nie jest golym „/magazyn" — warunek „dokladaj
      // tylko przy zawezeniu" nie mialby czego wylapac, a odsylalby z powrotem na domyslne
      // sortowanie kogos, kto ulozyl liste po innej kolumnie.
      adresPominietych: zWroc('/magazyn/pominiete', adresPowrotuListy),
      adresEkranuPowiazan: zWroc('/magazyn/powiazania', adresPowrotuListy),
      adresPowrotuListy,
      wiersze: znalezione.map((w) => ({ ...wierszKarty(w, adresPowrotuListy), naStanie: naStanie(w.id) })),
      stany: stany.wlaczone ? {
        od: fmtDataCzas(stany.granica), naMinusie, bezKarty: stany.bezKarty,
        adresImportu: '/magazyn/stany/import', adresBezKarty: '/magazyn/stany/bez-karty',
      } : null,
      naglowkiKanalow: NAGLOWKI_KANALOW,
      // Adres, stan aktywnosci i strzalka KAZDEGO naglowka sortujacego — policzone tutaj,
      // bo widok w tym module niczego nie rozstrzyga.
      sortowanie: linkiSortowania(sort, kier, filtry, zaznaczWszystkie, widok),
      przebieg: opisPrzebiegu(magazyn.stan()),
      // ⚠️ Dwie liczby do linii odczytu (`zliczeniaNiepowiazanych` z Zadania 1): ile
      // produktow lustra czeka jeszcze na karte, i osobno, ile z nich to oferty Allegro
      // czekajace na reczne powiazanie (`/magazyn/powiazania`) — widok niczego nie liczy.
      niepowiazane: zliczeniaNiepowiazanych(db),

      // ——— KAFLE BRAKOW ———
      // Kolejnosc i tryb kolumn jada tym samym stanem adresu, co kazdy inny odnosnik ekranu
      // (niezmiennik 4.13b) — inaczej klikniecie kafla kasowaloby aktywne sortowanie albo
      // odsylalo z trybu katalogowego do porzadkow.
      kafle: kafleBrakow(zliczenia, filtry, { sort, kier, widok }),

      // ——— TRYB KOLUMN TABELI ———
      // ⚠️ DWA UKLADY JEDNEJ TABELI, nie dwie tabele: `porzadki` (domyslny) zamienia cztery
      // kolumny cen na jedna kolumne „Stan" (ile brakuje przy karcie), `katalog` przywraca
      // dzisiejszy zestaw z cenami. Rozstrzyga TRASA — widok tylko wypisuje.
      widok,
      // Przelacznik jest JEDYNYM odnosnikiem ekranu, ktory tryb ZMIENIA — i robi to
      // `adresMagazynu`, czyli z PELNYM kompletem: zawezenie i kolejnosc maja przezyc
      // przelaczenie kolumn (to ta sama regula, co przy naglowkach sortujacych).
      // ⚠️ ZAZNACZENIE JEDZIE DALEJ — z tego samego powodu, co przy sortowaniu, tylko
      // mocniejszego: naglowek zmienia KOLEJNOSC, a przelacznik nie zmienia nawet jej,
      // wylacznie ZESTAW KOLUMN. Zbior wierszy jest po obu stronach ten sam, wiec zgubienie
      // `zaznacz` odhaczaloby cala liste w polowie roboty — a droga typowa wyglada tak:
      // zawez do 277 do przejecia, zaznacz wszystkie, zajrzyj w ceny kanalow „na kontrole".
      adresPrzelacznika: adresMagazynu(filtry, {
        sort, kier, zaznacz: zaznaczWszystkie, widok: widok === 'katalog' ? 'porzadki' : 'katalog',
      }),
      etykietaPrzelacznika: widok === 'katalog' ? '← wróć do porządków' : 'pokaż ceny kanałów →',
      // ⚠️ SZEROKOSC KOMUNIKATU PUSTEJ TABELI liczy sie z ZESTAWU KOLUMN, wiec zalezy od
      // trybu — policzona w widoku rozjechalaby sie po cichu przy pierwszej zmianie kolumn,
      // a komunikat przestalby siegac konca tabeli i wygladalby jak polamany render.
      kolumnPustej: (widok === 'katalog' ? 6 + NAGLOWKI_KANALOW.length : 7) + (stany.wlaczone ? 1 : 0),
      // Co dzis zawęża liste — zdanie nad tabela, POLICZONE (widok niczego nie liczy).
      opisZawezenia: opisZawezenia(filtry, znalezione.length),
      // Liczba wynikow PRZY zawezeniu (pasek chipow) — TA SAMA odmiana trojformowa co
      // `ileKart` uzywa dwie linijki wyzej w `opisZawezenia`. Druga kopia w widoku
      // (dwuformowe „karta"/„kart") mowilaby przy dwoch wynikach „2 kart" zamiast
      // „2 karty" — widok niczego nie liczy, wiec liczebnik stoi tutaj.
      napisWynikuFiltra: ileKart(znalezione.length),

      // ——— ZAZNACZENIE ———
      zaznaczWszystkie,
      // Oba adresy skladane TU, z zachowaniem zawezenia I kolejnosci — inaczej „zaznacz
      // wszystkie" zdejmowaloby filtr i czlowiek zaznaczylby karty, ktorych nie widzial.
      // ⚠️ To NIE JEST teoretyczne: przy przejeciu numerow zaznaczenie prowadzi do zapisu
      // nieodwracalnego z panelu, a katalog ma ~1000 pozycji przy 277 do przejecia.
      // ⚠️ TRYB KOLUMN JEDZIE Z NIMI. Stan pol wyboru pamieta przegladarka, ale sam odnosnik
      // PRZELADOWUJE strone — bez trybu „zaznacz wszystkie" przerzucaloby czlowieka
      // z katalogu do porzadkow w polowie zaznaczania.
      adresZaznaczWszystkie: adresMagazynu(filtry, { sort, kier, zaznacz: true, widok }),
      adresOdznaczWszystkie: adresMagazynu(filtry, { sort, kier, widok }),

      // ——— WYSZUKIWARKA I FILTRY ———
      filtry,
      // Wartosci POL formularza (ceny z powrotem w zlotowkach, brak jako pusty napis) —
      // liczy je domena, zeby widok nie musial wiedziec, ze filtry zyja w groszach.
      wartosci: wartosciPol(filtry),
      // ⚠️ CZY COKOLWIEK ZAWEZA LISTE. Od tego zalezy, CO MOWI PUSTA TABELA: „nie ma tu
      // jeszcze ani jednej karty produktu" przy aktywnym filtrze jest NIEPRAWDA i wyglada jak utrata
      // danych — katalog ma ~1000 pozycji, a ekran twierdzi, ze jest pusty.
      filtrowane: saJakiesFiltry(filtry),
      // Oba formularze GET niosa nawzajem swoje wartosci ukrytymi polami — inaczej klikniecie
      // „Filtruj" gubiloby fraze, a wpisanie frazy gubiloby filtry (niezmiennik 4.13b).
      ukryteWFiltrach: [
        ...parametryUkryte(filtry, { pomin: POLA_FORMULARZA_FILTROW }), ...stanUkryty,
      ],
      ukryteWSzukajce: [...parametryUkryte(filtry, { pomin: ['fraza'] }), ...stanUkryty],
      // „Wyczysc filtry" zdejmuje zawezenie, ale NIE kolejnosc ani NIE tryb kolumn —
      // ani jedno, ani drugie nie jest filtrem.
      adresBezFiltrow: adresMagazynu({}, { sort, kier, widok }),
      // Pozycje pol wyboru. Etykiety kanalow z `adresKanalu` (ta sama funkcja, co w naglowku
      // kolumny), reszta ze slownikow domeny — druga mapa nazw rozjechalaby sie z pierwsza.
      kanalyDoFiltra: NAGLOWKI_KANALOW,
      paczkomatDoFiltra: PACZKOMAT_DO_FILTRA.map(
        (klucz) => ({ klucz, etykieta: PACZKOMAT_ETYKIETY[klucz] }),
      ),
      kategorieDoFiltra: kategorieDoFiltra(db),

      // ——— PASEK EDYCJI HURTEM ———
      // ⚠️ LICZBA PASUJACYCH JEST TU CALA UCZCIWOSCIA OPCJI „wszystkie pasujace". Czlowiek
      // ma wiedziec, ze dotyka 645 kart, a nie 20, ktore widzi na ekranie — i musi to
      // byc TA SAMA liczba, co dlugosc listy nizej, bo obie biora sie z jednego odczytu.
      ilePasujacych: znalezione.length,
      // ⚠️ ZAWEZENIE JEDNYM POLEM, nie siedmioma osobnymi: formularz hurtowy ma WLASNE pole
      // `paczkomat`, a filtr ma pole `paczkomat` — te same nazwy w jednym formularzu wracaja
      // z Fastify jako TABLICA i kasuja sie nawzajem (patrz `filtryZawezenia`). Skladane
      // z `adresMagazynu`, czyli z TEGO SAMEGO miejsca, co kazdy odnosnik ekranu.
      // ⚠️⚠️ JEDYNE MIEJSCE EKRANU BEZ TRYBU KOLUMN — i to nie jest przeoczenie. To pole
      // opisuje ZBIOR, ktorego dotknie akcja hurtowa, a tryb kolumn jest UKLADEM EKRANU:
      // wpuszczony tutaj jechalby razem z zawezeniem w zadanie zapisujace setki kart
      // i udawal kryterium wyboru. Dokladnie z tego samego powodu nie ma tu `zaznacz`
      // (patrz `adresMagazynu` w domenie) — a `sort`/`kier` nie ma, bo kolejnosc nie
      // zmienia zbioru.
      zawezenieHurtu: adresMagazynu(filtry).split('?')[1] ?? '',
      // Pozycje pola wyboru kategorii w pasku hurtu — ta sama lista, co w filtrze.
      // ⚠️ POLE WYBORU, NIE TEKSTOWE: wpisana z pamieci literowka ustawilaby hurtem
      // kategorie, ktorej nie ma w zadnym sklepie, i to od razu sześciuset kartom.
      paczkomatDoHurtu: PACZKOMAT_DO_FILTRA.map(
        (klucz) => ({ klucz, etykieta: PACZKOMAT_ETYKIETY[klucz] }),
      ),
    });
  });
}
