// Port frozen 5b9cd765: 890–1074.
import { stanyKart } from '../../oms/db/stany-magazynowe.js';
import { fmtDataCzas } from '../../domena/format-daty.js';
import { STANY_PO_POLSKU } from './oferty.js';
import { rodzajKanalu } from '../../domena/kanaly.js';
import { kanalyDostepnosciKart } from '../../oms/db/magazyn.js';
import { BRAK_ZGODY_OFERT } from '../kanaly/services/oferty-allegro-ustawienia.ts';
import { liczbaOfertDoDecyzji } from '../../oms/db/oferty-kanalow.ts';

/**
 * PRZ-160.P3a.02: plakietki kolumny „Kanały” jednej karty — po jednej na polaczenie, w ktorym
 * karta jest dostepna (dwa konta Allegro = dwie plakietki). Rodzaj i litera z `typ` definicji
 * kanalu (`rodzajKanalu`, ta sama plakietka co na liscie zamowien), opis = etykieta polaczenia.
 * Lustro (`obecne`) daje Allegro/Woo; ERLI wylacznie z rejestru ofert: `aktywna` = zwykla
 * plakietka, kazdy inny stan = wyszarzona ze stanem (i bledem) w opisie. Kanal spoza definicji
 * (bez rodzaju) nie dostaje plakietki. Kolejnosc stala: po typie, potem po nazwie.
 * PRZ-160.E3.14: oferta z rejestru na koncie innym niz ERLI (np. szkic Allegro, „do wysłania”) tez
 * dostaje plakietke ze stanem — chyba ze lustro juz pokazuje to konto jako dostepne.
 */
function plakietkiKanalow(obecne, oferty, definicje) {
  const nazwa = (kanal) => definicje.find((d) => d?.klucz === kanal)?.etykieta ?? kanal;
  const wynik = [];
  for (const kanal of obecne) {
    const rodzaj = rodzajKanalu(kanal, definicje);
    if (rodzaj && rodzaj.klucz !== 'erli') wynik.push({ rodzaj, nazwa: nazwa(kanal), opis: nazwa(kanal), aktywna: true });
  }
  const zRejestru = new Map();
  for (const o of oferty) {
    const rodzaj = rodzajKanalu(o.kanal, definicje);
    if (!rodzaj || (rodzaj.klucz !== 'erli' && obecne.includes(o.kanal))) continue;
    const byla = zRejestru.get(o.kanal);
    if (!byla || (o.stan === 'aktywna' && byla.stan !== 'aktywna')) zRejestru.set(o.kanal, o);
  }
  for (const [kanal, o] of zRejestru) {
    const aktywna = o.stan === 'aktywna';
    const stan = `${STANY_PO_POLSKU[o.stan] ?? o.stan}${o.blad ? `: ${o.blad}` : ''}`;
    wynik.push({ rodzaj: rodzajKanalu(kanal, definicje), nazwa: nazwa(kanal), opis: aktywna ? nazwa(kanal) : `${nazwa(kanal)} — ${stan}`, aktywna });
  }
  return wynik.sort((a, b) => (a.rodzaj.klucz < b.rodzaj.klucz ? -1 : a.rodzaj.klucz > b.rodzaj.klucz ? 1 : a.nazwa.localeCompare(b.nazwa, 'pl')))
    .map(({ rodzaj, opis, aktywna }) => ({ klucz: rodzaj.klucz, znak: rodzaj.znak, opis, aktywna }));
}

export function registerListaMagazynu(app, { db, magazyn, sklepy, definicje = /** @type {ReadonlyArray<{ klucz: string, typ?: string, etykieta?: string }>} */ ([]), pomoc, karta, trescAllegro, kontaErli = /** @returns {{ klucz: string }[]} */ () => [], kontaAllegro = /** @returns {{ klucz: string, zgoda?: boolean }[]} */ () => [] }) {
  const { kartyZKanalami, kategorieDoFiltra, markiDoFiltra, SORTOWANIE_KART, BRAKI_ETYKIETY, filtryZZapytania, saJakiesFiltry, parametryUkryte, wartosciPol, adresMagazynu, PACZKOMAT_DO_FILTRA, PACZKOMAT_ETYKIETY, POLA_FORMULARZA_FILTROW, NAGLOWKI_KANALOW, BEZ_SKLEPOW, opisPrzebiegu, opisPrzebieguTresci, linkiSortowania, wierszKarty, ileKart, opisZawezenia } = pomoc;
  app.get('/magazyn', async (req, reply) => {
    if (!magazyn || magazyn.gotowy?.() === false) return reply.view('pusta-strona.ejs', { ...BEZ_SKLEPOW, szerokosc: 'tabela' });

    // ⚠️ BIALA LISTA, nie `SORTOWANIE[x] ?? domyslne`. Ta druga postac oddaje funkcje
    // z `Object.prototype` przy `?sort=constructor` i konczy sie pieciusetka na glownym
    // ekranie — zlapane przy Zadaniu 4. Klucze zapytania pomijają usunięte kolumny,
    // a `Set.has` nie zaglada do prototypu.
    const dozwolone = new Set(SORTOWANIE_KART.filter(klucz => !['paczkomat', 'braki'].includes(klucz)));
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
    // PRZ-160.E3.14: „Wystaw na…” — konta obu typów; konto Allegro bez zgody na oferty (D21) zostaje na liście, wyszarzone.
    const kontaOfert = [
      ...kontaErli().map(k => ({ klucz: k.klucz, etykieta: `ERLI · ${k.klucz}`, allegro: false, zgoda: true })),
      ...kontaAllegro().map(k => ({ klucz: k.klucz, etykieta: `Allegro · ${k.klucz}${k.srodowisko === 'sandbox' ? ' (sandbox)' : ''}`, allegro: true, zgoda: k.zgoda !== false })),
    ];
    // PRZ-160.P3a.02: kolumna „Kanały” (dawniej „Oferty”) — zawsze, gdy firma ma choc jeden kanal.
    const pokazOferty = definicje.length > 0;
    const obecnosc = new Map();
    if (pokazOferty) {
      // Status publikacji liczy sie dla kazdego konta Allegro z definicji (te same, co plakietka) —
      // takze konta bez kompletnej konfiguracji, bo jego ENDED/INACTIVE nie moze wygladac na dostepne.
      const kanalyZeStatusem = definicje.filter((d) => rodzajKanalu(d.klucz, definicje)?.klucz === 'allegro').map((d) => d.klucz);
      for (const { karta_id, kanal } of kanalyDostepnosciKart(db, znalezione.map((w) => w.id), { kanalyZeStatusem })) {
        (obecnosc.get(Number(karta_id)) ?? obecnosc.set(Number(karta_id), []).get(Number(karta_id))).push(kanal);
      }
    }

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

    return reply.view('magazyn-lista.ejs', { szerokosc: 'tabela',
      title: 'Magazyn',
      // D63: ekrany stanów w kanałach tylko dla admina — link też.
      adminStanowKanalow: req.konto?.admin === true,
      kontaOfert: req.konto?.admin ? kontaOfert : [],
      liczbaProblemowOfert: req.konto?.admin ? liczbaOfertDoDecyzji(db) : 0,
      brakZgodyOfert: BRAK_ZGODY_OFERT,
      pokazOferty,
      adresPowrotuListy,
      wiersze: znalezione.map((w) => ({ ...wierszKarty(w, adresPowrotuListy), naStanie: naStanie(w.id),
        plakietkiKanalow: pokazOferty ? plakietkiKanalow(obecnosc.get(Number(w.id)) ?? [], w.oferty ?? [], definicje) : [] })),
      stany: stany.wlaczone ? {
        od: fmtDataCzas(stany.granica), naMinusie, bezKarty: stany.bezKarty,
        adresImportu: '/magazyn/stany/import', adresBezKarty: '/magazyn/stany/bez-karty',
      } : null,
      naglowkiKanalow: NAGLOWKI_KANALOW,
      // Adres, stan aktywnosci i strzalka KAZDEGO naglowka sortujacego — policzone tutaj,
      // bo widok w tym module niczego nie rozstrzyga.
      sortowanie: linkiSortowania(sort, kier, filtry, zaznaczWszystkie, widok),
      przebieg: opisPrzebiegu(magazyn.stan()),
      // PRZ-160.04b: przycisk treści ofert tylko przy połączonym koncie Allegro (`null` = bez przycisku).
      trescAllegro: opisPrzebieguTresci(trescAllegro && trescAllegro.gotowy?.() !== false ? trescAllegro.stan() : null),

      // Tryb porzadkow pomija ceny kanalow; katalog je pokazuje.
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
      // PRZ-160.P3b.02: + kolumna Marka
      kolumnPustej: (widok === 'katalog' ? 6 + NAGLOWKI_KANALOW.length : 6) + (stany.wlaczone ? 1 : 0) + (pokazOferty ? 1 : 0),
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
      brakiDoFiltra: ['sku', 'wymiary', 'paczkomat', 'kategoria', 'zdjecie', 'opis', 'komplet']
        .map(klucz => ({ klucz, etykieta: BRAKI_ETYKIETY[klucz] })),
      kategorieDoFiltra: kategorieDoFiltra(db),
      markiDoFiltra: markiDoFiltra(db),

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
