import * as dbMagazynu from '../../oms/db/magazyn.js';
import { polecenieZFormularza, zmianyHurtem, polaDoPrzeniesienia } from '../../domena/magazyn-hurt.js';
import { proponujSku } from '../../domena/sku-generator.js';
import { przejeciaZeSklepu } from '../../domena/przejecie-sku.js';
import { ocenZapis as ocenZapisDomeny } from '../../domena/zapis-do-sklepu.js';
import { jednostkiSklepow, wyslijDoSklepow } from './services/magazyn-zapis.js';
import { propozycje, propozycjeOfert } from '../../domena/dopasowanie-ofert.js';
import { grupujPominiete as grupujDomeny } from '../../domena/magazyn-pominiete.js';
import { kanalyZrodloweKart } from '../../domena/karta-z-produktu.js';
import {
  filtryZZapytania as filtryDomeny, saJakiesFiltry, parametryUkryte, wartosciPol, adresMagazynu,
  PACZKOMAT_DO_FILTRA, BRAKI_ETYKIETY, PACZKOMAT_ETYKIETY,
} from '../../domena/magazyn-filtry.js';
import { adresKanalu as opisKanalu } from '../../domena/kanaly.js';
import { miniaturaZLustra } from '../../domena/miniatura-pozycji.js';
import { opisWymiarow, centymetryZMilimetrow, milimetryZCentymetrow, gramyZKilogramow } from '../../domena/rozmiar.js';
import { czyPaczkomat } from '../../domena/paczkomat.js';
import { zl } from '../../domena/kwoty.js';
import { fmtDataCzas } from '../../domena/format-daty.js';
export function createPomocnikiMagazynu({ kanalySklepow, kanalyAllegro, definicje }) {
  const adresKanalu = (klucz) => opisKanalu(klucz, definicje);
  const KANALY_SKLEPOW = kanalySklepow;
  const KANALY_ALLEGRO = kanalyAllegro;
  const KANALY_MAGAZYNU = [...kanalySklepow, ...kanalyAllegro];
  // PRZ-090: bez sklepu Woo karty powstają z ofert Allegro — ta sama lista dla zakładania, „pominiętych” i grup.
  const KANALY_ZRODLOWE = kanalyZrodloweKart(kanalySklepow, kanalyAllegro);
  const filtryZZapytania = q => filtryDomeny(q, KANALY_MAGAZYNU);
  const ocenZapis = (w,p,j) => ocenZapisDomeny(w,p,j,kanalySklepow);
  const grupujPominiete = p => grupujDomeny(p,KANALY_ZRODLOWE);
  const { kartyZKanalami, produktyPominiete, utworzKartyZNiepowiazanych, kategorieDoFiltra, SORTOWANIE_KART, niepowiazaneOfertyAllegro, powiazaneOfertyAllegro, kartyDoPowiazania, powiazOfertyHurtem, odepnijOferte, kartaPoId, produktyKarty, kartaZeSku, zapiszKarte, kartyPoIdach, zastosujHurtem, zajeteSku, nadajSku, produktyKart, zapiszSkuSklepu, zliczeniaBrakow, zliczeniaNiepowiazanych } = {
    ...dbMagazynu,
    produktyPominiete: db => dbMagazynu.produktyPominiete(db, KANALY_ZRODLOWE),
    utworzKartyZNiepowiazanych: db => dbMagazynu.utworzKartyZNiepowiazanych(db, { kanalySklepow: KANALY_ZRODLOWE }),
    zliczeniaNiepowiazanych: db => dbMagazynu.zliczeniaNiepowiazanych(db, kanalyAllegro),
    niepowiazaneOfertyAllegro: db => dbMagazynu.niepowiazaneOfertyAllegro(db, kanalyAllegro),
    powiazaneOfertyAllegro: db => dbMagazynu.powiazaneOfertyAllegro(db, kanalyAllegro),
    powiazOfertyHurtem: (db,pary) => dbMagazynu.powiazOfertyHurtem(db,pary,kanalyAllegro),
    odepnijOferte: (db,id) => dbMagazynu.odepnijOferte(db,id,kanalyAllegro),
  };


// EKRAN MAGAZYNU. Trasa jest CIENKA: parsuje zadanie, wola zapytanie, sklada wiersze i
// renderuje. Reguly siedza w `domain/` (rozmiar, paczkomat, miniatury, grupowanie
// pominietych), zapytania w `db/magazyn.js`, odczyt sklepow w `services/magazyn-przebieg.js`.
//
// ⚠️ WIDOK NICZEGO NIE LICZY I NICZEGO NIE ROZSTRZYGA — wszystko przychodzi policzone stad
// (ta sama zasada, co w faktury.ejs). Druga kopia reguly w widoku rozjechalaby sie
// z pierwsza przy pierwszej zmianie, a tu chodzi o wymiary, z ktorych powstaje paczka, gabaryt i wymiar w sklepie.
//
// ⚠️ CZEGO TU NIE MA I BYC NIE MUSI: uwierzytelniania i CSRF. Straznik sesji
// (`zbudujStraznika`) i `zarejestrujOchroneCsrf` sa hakami GLOBALNYMI (server.js), wiec ta
// trasa jest chroniona z definicji. Wlasny `preHandler` bylby druga bramka obok pierwszej.
// Z tego samego powodu widok nie dostaje stad `motyw` ani `sciezkaPowrotu` — wstawia je
// globalny hook do KAZDEGO widoku.

// ⚠️ CZTERY OSOBNE KOLUMNY, Allegro rozbite na dwa konta (wymaganie wlasciciela). Kolejnosc
// jest kolejnoscia kolumn na ekranie i JEDNYM zrodlem dla naglowka i dla wierszy — dwie
// listy rozjechalyby sie o jedna kolumne, czyli cena ze sklepu B wyladowalaby pod sklepem A.
//
// ⚠️ TA SAMA LISTA JEST LISTA WARTOSCI FILTRU KANALU (`KANALY_MAGAZYNU` z domeny). Trzecia
// kopia rozjechalaby sie po cichu w jedna albo w druga strone: filtr oferowalby kanal,
// ktory nie ma na ekranie kolumny, albo kolumna stalaby bez mozliwosci zawezenia do niej.
const KOLUMNY_KANALOW = KANALY_MAGAZYNU;

// Pola, ktore FORMULARZ FILTROW wysyla SAM. Ukrytymi polami niesie wylacznie reszte —
// wyslane dwa razy wracaja z Fastify jako TABLICA, ktora parser slusznie odrzuca do `null`,
// czyli filtr znikalby dokladnie w tym formularzu, ktory sluzy do jego ustawiania.
//
// ⚠️ 'brak' NIE JEST TU JUZ WLASNYM POLEM (przebudowa 2026-08-25): formularz filtrow nie ma
// wlasnego selecta „Braki" — filtr brak=… ustawia sie kaflem nad tabela (`kafleBrakow`).
// Zdjecie 'brak' z tej listy jest wiec TYM, co sprawia, ze wartosc jedzie dalej UKRYTYM
// polem (`parametryUkryte` robi to samo z siebie po zdjeciu z listy `pomin`) — inaczej
// klikniecie „Filtruj" kasowaloby filtr wlasnie ustawiony kaflem.
const POLA_FORMULARZA_FILTROW = Object.freeze(
  ['kanal', 'kategoria', 'paczkomat', 'cenaOd', 'cenaDo'],
);

// Nazwy kanalow bierzemy z `domain/kanaly.js` — TEJ SAMEJ mapy, ktora opisuje kolumne
// „Kanal sprzedazy" na liscie zamowien i pozycje filtra kanalu. Druga mapa etykiet
// rozjechalaby sie przy pierwszej zmianie nazwy konta.
const NAGLOWKI_KANALOW = Object.freeze(
  KOLUMNY_KANALOW.map((klucz) => ({ klucz, etykieta: adresKanalu(klucz) })),
);

// ⚠️ ZAKLADKA MA ODPOWIEDZIEC TAKZE WTEDY, GDY PANEL NIE MA ANI JEDNEGO SKLEPU. Ikona
// w pasku prowadzaca w 404 wyglada jak usterka panelu, a nie jak funkcja, ktorej jeszcze
// nie ma — ta sama decyzja, co przy /faktury, /raporty i /ustawieniach.
const BEZ_SKLEPOW = {
  title: 'Magazyn',
  naglowek: 'Magazyn',
  opis: 'Ten panel nie ma podpiętego żadnego sklepu ani konta Allegro, więc nie ma skąd wziąć '
    + 'katalogu — zakładka jest pusta celowo. Magazyn buduje się z odczytu sklepów; kanały '
    + 'dopisuje się w zmiennej OMS_KANALY w pliku konfiguracji OMS (instrukcja: docs/instalacja-docker.md, sekcja 9), a bez nich nie ma o co pytać.',
};

const BEZ_SKLEPOW_ODMOWA = 'Panel nie ma podpiętego żadnego sklepu ani konta Allegro — '
  + 'nie ma skąd czytać katalogu.';

// Adres produktu z lustra laduje wprost w atrybucie `href` naszego HTML-a, a lustro bierze
// sie z cudzego API (`zapiszProduktSklepowy` przepuszcza dowolny napis w kolumnie `adres`).
// Ten sam warunek, co przy adresach zdjec w `domain/miniatury.js` i `services/magazyn-sync.js`
// — i z tego samego powodu. Adres, ktoremu odmawiamy, gasi WYLACZNIE odnosnik: cena zostaje
// na ekranie, bo o niej ten wiersz mowi.
const ADRES_HTTP = /^https?:\/\//i;
const adresSklepu = (a) => (typeof a === 'string' && ADRES_HTTP.test(a.trim()) ? a.trim() : null);

/**
 * MINIATURA KARTY — z pierwszego kanalu, ktory JA MA, w kolejnosci kolumn.
 *
 * ⚠️⚠️ WARTOSC ZAPISANA, NIGDY WYLICZONA Z NAZWY PLIKU. Do 2026-08-12 stalo tu
 * `adresMiniatury(pierwszeZdjecie(...))`, czyli doklejenie `-150x150` do nazwy pliku
 * oryginalu. Zmierzone wtedy na WSZYSTKICH adresach obu sklepow: sklep B 103/103
 * trafien, sklep A 76/684 — 608 razy 404 (89%), bo TEN sklep skaluje miniatury do
 * 247x296. Prawdziwy adres przynosi teraz odczyt katalogow ze Store API i kladzie go
 * w kolumnie `miniatura` (services/magazyn-sync.js, domain/miniatury.js).
 *
 * ⚠️⚠️ BRAK ZOSTAJE BRAKIEM. Zaden odwrot do zgadywania i zadne podstawienie oryginalu:
 * pierwsze daje 404, drugie sciaga na JEDNA strone listy ponad 150 MB zdjec produktowych.
 * Pusta komorka jest dzis i tak stanem widocznym, a wypelni sie sama po najblizszym odczycie.
 *
 * ⚠️ KOLEJNOSC JEST STALA, a nie „ktore znajdzie sie pierwsze w obiekcie": ta sama karta ma
 * pokazywac te sama miniature przy kazdym odswiezeniu, takze po odczycie, ktory dolozyl kanal.
 */
function zapisanaMiniatura(kanaly) {
  for (const klucz of KOLUMNY_KANALOW) {
    const adres = kanaly?.[klucz]?.miniatura;
    // Lustro bierze sie z cudzego API, a wartosc laduje wprost w atrybucie `src` naszego
    // HTML-a — ten sam warunek, co przy adresie produktu obok.
    if (typeof adres === 'string' && ADRES_HTTP.test(adres.trim())) return adres.trim();
  }
  return null;
}

/**
 * Komorka jednego kanalu. Trzy stany, i wszystkie trzy znacza CO INNEGO:
 *   - `null` → karty nie ma w tym kanale (widok pokaze kreske);
 *   - `{ cena: null }` → produkt jest, ale bez ceny (rodzic wariantowego, produkt
 *     w przygotowaniu) — kreska twierdzilaby, ze karty tam nie ma;
 *   - `{ cena: '74.90' }` → jest i kosztuje.
 */
function komorkaKanalu(produkt) {
  if (!produkt) return null;
  return {
    cena: produkt.cena_gr === null || produkt.cena_gr === undefined ? null : zl(produkt.cena_gr),
    adres: adresSklepu(produkt.adres),
    sku_sklepu: produkt.sku_sklepu ?? null,
  };
}

/**
 * Pominiete produkty z nazwa kanalu gotowa do wyswietlenia.
 *
 * ⚠️ TA SAMA NAZWA, CO NA LISCIE (`adresKanalu`) — i to nie jest kosmetyka. Ekran „pominiete"
 * pokazywal surowy klucz z lustra (`allegro_b`), a lista obok — `Allegro
 * konto B`. Ten sam kanal pod dwiema nazwami w tym samym panelu znaczy, ze czlowiek
 * porownujacy oba ekrany musi sam zgadnac, czy patrzy na to samo konto. Regula stoi
 * w komentarzu przy `NAGLOWKI_KANALOW` wyzej; ten widok jej nie przestrzegal.
 *
 * Etykieta DOKLADANA obok `kanal`, a nie w jego miejsce: `grupujPominiete` rozstrzyga po
 * `kanal` (biala lista kanalow sklepowych), wiec podmiana zabralaby mu dane do decyzji.
 */
const zEtykietaKanalu = (produkty) => produkty.map((p) => ({ ...p, etykietaKanalu: adresKanalu(p.kanal) }));

// Odmiana „kanał/kanały/kanałów" dla znacznika w linii odczytu. POLICZONA TUTAJ, nie
// w widoku (widok niczego nie liczy) — 1 „kanał", 2–4 „kanały", reszta (0 i 5+) „kanałów".
// Badge w widoku sie nie pokazuje przy zerze (warunek `przebieg.kanaly.length`), ale funkcja
// ma sie zgodzic tez wtedy, zeby nie byla cicha pulapka przy przyszlym uzyciu.
function opisLiczbyKanalow(ile) {
  if (ile === 1) return '1 kanał ok';
  if (ile >= 2 && ile <= 4) return `${ile} kanały ok`;
  return `${ile} kanałów ok`;
}

/**
 * Stan przebiegu z nazwami kanalow gotowymi do wyswietlenia.
 *
 * ⚠️ NAZWA KANALU SKLADA SIE TUTAJ, a nie w widoku: `blad` z odczytu mowi o kluczu
 * (`sklep_b`), a czlowiek patrzacy na ekran mysli adresem sklepu (`sklep-b.example`). Jedno
 * miejsce, w ktorym te dwie postacie sie spotykaja, to `domain/kanaly.js`.
 *
 * ⚠️⚠️ REGULA Z SEKCJI 9 PRZEWODNIKA (przebudowa 2026-08-25, Zadanie 3): wynik odczytu MUSI
 * BYC WIDOCZNY — cichy zly odczyt ma wygladac IDENTYCZNIE jak sklep bez zmian WYLACZNIE
 * wtedy, gdy naprawde nic sie nie stalo. `otworz` rozstrzyga, czy `<details>` na ekranie
 * renderuje sie z atrybutem `open`: zwiniecie wolno WYLACZNIE przy spokoju — trwanie i
 * KAZDY blad (przebiegu jako calosci albo pojedynczego kanalu) maja sekcje otworzyc.
 * Ta decyzja siedzi TUTAJ, nigdy w widoku (ten sam powod, co przy nazwie kanalu wyzej).
 */
function opisPrzebiegu(stan) {
  const kanaly = (stan?.kanaly ?? []).map((k) => ({ ...k, etykieta: adresKanalu(k.kanal) }));
  return {
    ...stan,
    kanaly,
    postep: stan?.postep ? { ...stan.postep, etykieta: adresKanalu(stan.postep.kanal) } : null,
    otworz: stan.trwa || Boolean(stan.blad) || kanaly.some((k) => k.blad),
    // Jedno zdanie zamiast trzech galezi w widoku (widok niczego nie liczy) — data przychodzi
    // sformatowana `fmtDataCzas`, ta sama funkcja, ktorej dotad uzywal wprost widok.
    streszczenie: stan.trwa
      ? 'trwa — nie zamykaj panelu'
      : (stan.skonczony_at
        ? `ostatni przebieg ${fmtDataCzas(stan.skonczony_at)}`
        : 'w tym uruchomieniu panelu jeszcze nieczytane'),
    // Gotowy napis znacznika „N kanały ok" — odmiana liczona TU, NIE w widoku.
    kanalyOk: opisLiczbyKanalow(kanaly.length),
  };
}

/**
 * Odnosniki sortujace naglowka tabeli, RAZEM ze stanem „po tej kolumnie wlasnie sortujemy".
 *
 * ⚠️ TO NIE JEST OZDOBA, TYLKO JEDYNY SPOSOB, W JAKI EKRAN MOWI PRAWDE O SOBIE. Nazwa
 * sortowania z adresu przechodzi przez biala liste i nierozpoznana WRACA DO DOMYSLNEJ —
 * a wtedy lista jest ulozona po nazwie, mimo ze w adresie stoi co innego. Bez znacznika
 * aktywnej kolumny ta podmiana bylaby niewidoczna: ekran pokazywalby jedna kolejnosc,
 * adres twierdzil drugie, i nikt by tego nie zestawil. `aria-sort` mowi to samo czytnikowi
 * ekranu, co strzalka oku.
 *
 * ⚠️⚠️ ADRES SKLADA SIE Z PELNEGO KOMPLETU (`adresMagazynu`), A NIE OD ZERA. Naglowek
 * budowany jako `/magazyn?sort=…&kier=…` GUBILBY fraze i wszystkie filtry — czyli klikniecie
 * w „Wymiary" kasowaloby zawezenie, po ktorym wlasciciel wlasnie chcial zaznaczyc wszystko
 * i ustawic pole hurtem. To jest ten sam blad, ktory na liscie zamowien dawal
 * „przefiltrowana, ale ZUPELNIE INNA liste" (niezmiennik 4.13b przewodnika).
 *
 * `Object.create(null)`, bo kluczami sa nazwy z adresu HTTP — na literale `{}` zapytanie
 * o „constructor" siegnaloby do prototypu (ta sama pulapka, co przy bialej liscie w db/).
 */
function linkiSortowania(sort, kier, filtry, zaznacz = false, widok = 'porzadki') {
  const przeciwny = kier === 'desc' ? 'asc' : 'desc';
  const linki = Object.create(null);
  for (const klucz of SORTOWANIE_KART) {
    const aktywna = klucz === sort;
    linki[klucz] = {
      // Klikniecie w AKTYWNA kolumne obraca kolejnosc; w kazda inna — ustawia rosnaca.
      // ⚠️ ZAZNACZENIE JEDZIE DALEJ, bo sortowanie zmienia KOLEJNOSC, a nie ZBIOR. Bez tego
      // klikniecie w „Wymiary" po zaznaczeniu wszystkiego odznaczaloby cala liste po cichu.
      // (Formularz filtrow zachowuje sie ODWROTNIE i tez celowo — patrz trasa listy.)
      // ⚠️ TRYB KOLUMN TEZ JEDZIE DALEJ, i z tego samego powodu: sortowanie nie zmienia ani
      // zbioru, ani zestawu kolumn. Bez niego klikniecie w naglowek w trybie katalogowym
      // odsylaloby na ekran porzadkow — czyli kolumny, ktore czlowiek wlasnie sortowal,
      // znikalyby mu spod reki.
      adres: adresMagazynu(filtry, {
        sort: klucz, kier: aktywna ? przeciwny : 'asc', zaznacz, widok,
      }),
      aktywna,
      aria: aktywna ? (kier === 'desc' ? 'descending' : 'ascending') : null,
      strzalka: aktywna ? (kier === 'desc' ? '▼' : '▲') : '',
    };
  }
  return linki;
}

// Kafle brakow: liczby po CALYM katalogu (zliczeniaBrakow — patrz db), adres kazdego
// kafla przez adresMagazynu z PELNYM stanem. Aktywny kafel linkuje na zdjecie filtra
// (toggle), pozostale na swoj brak. Procent liczony TU — widok niczego nie liczy.
//
// ⚠️ KOLEJNOSC JEST CZESCIA UKLADU EKRANU (sku, wymiary, paczkomat, kategoria, komplet) —
// makieta i kolejne zadania licza na TA WLASNIE kolejnosc kafli, wiec nie jest przypadkowa
// kolejnoscia iteracji po obiekcie `zliczenia`.
function kafleBrakow(zliczenia, filtry, stanAdresu = {}) {
  const braki = [
    { klucz: 'sku', ile: zliczenia.bezSku, dopisek: `${zliczenia.doPrzejecia} przejmie ze sklepu` },
    { klucz: 'wymiary', ile: zliczenia.bezWymiarow, dopisek: null },
    { klucz: 'paczkomat', ile: zliczenia.bezPaczkomatu, dopisek: null },
    { klucz: 'kategoria', ile: zliczenia.bezKategorii, dopisek: null },
  ].map((k) => ({
    ...k,
    etykieta: BRAKI_ETYKIETY[k.klucz],
    aktywny: filtry.brak === k.klucz,
    adres: adresMagazynu({ ...filtry, brak: filtry.brak === k.klucz ? null : k.klucz }, stanAdresu),
  }));
  braki.push({
    klucz: 'komplet',
    etykieta: 'kompletnych kart',
    ile: zliczenia.komplet,
    razem: zliczenia.razem,
    procent: zliczenia.razem ? Math.round((zliczenia.komplet / zliczenia.razem) * 100) : 0,
    aktywny: filtry.brak === 'komplet',
    adres: adresMagazynu({ ...filtry, brak: filtry.brak === 'komplet' ? null : 'komplet' }, stanAdresu),
    dopisek: null,
  });
  return braki;
}

// ⚠️ `adresPowrotuListy` to WLASNY adres TEJ listy (`adresMagazynu(filtry, {sort, kier,
// widok})` od wywolujacego, Zadanie 6) — kazdy wiersz linkuje karte z NIM jako `wroc`, zeby
// powrot z karty trafil TU, a nie na goly „/magazyn". Koder liczy sie TUTAJ, przez
// `adresKarty` (ten sam, co na karcie), a NIE w widoku — widok niczego nie liczy.
function wierszKarty(w, adresPowrotuListy) {
  return {
    id: w.id,
    nazwa: w.nazwa,
    sku: w.sku || null,
    // Milimetry → „70 × 100 cm" liczy domena, nie widok (domain/rozmiar.js).
    wymiary: opisWymiarow(w),
    kategoria: w.kategoria_glowna || null,
    // Trzy stany paczkomatu; `null` znaczy „jeszcze nieoznaczone" i to CO INNEGO niz 'nie'.
    paczkomat: czyPaczkomat(w),
    miniatura: zapisanaMiniatura(w.kanaly),
    kanaly: KOLUMNY_KANALOW.map((klucz) => komorkaKanalu(w.kanaly?.[klucz])),
    // ⚠️ KOLUMNA „STAN" TRYBU PORZADKOW — ile brakuje przy tym karcie. Liczbe przynosi
    // zapytanie (`liczba_brakow`, TO SAMO wyrazenie, co filtr braków i kafle nad tabela),
    // wiec wiersz nie ma prawa twierdzic czego innego niz zawezenie, ktore go tu wpuscilo.
    //
    // ⚠️ LICZEBNIK POLICZONY TUTAJ, nie w widoku (widok niczego nie liczy). Braki sa 1–4,
    // wiec forma „brakow" (12–14) jest nieosiagalna — ale ta galaz i tak liczy poprawnie
    // to, co dostanie, zeby nie byla cicha pulapka przy dolozeniu piatego braku.
    stan: w.liczba_brakow === 0
      ? { komplet: true, tekst: 'komplet' }
      : { komplet: false, tekst: `${w.liczba_brakow} ${w.liczba_brakow === 1 ? 'brak' : 'braki'}` },
    adresKarty: adresKarty(w.id, { wroc: adresPowrotuListy }),
  };
}

// Liczebnik po polsku ma TRZY formy: „1 karta", „3 karty", „5 kart" — wariant dwuformowy
// pisalby „3 kart". ⚠️ 12, 13 i 14 IDA DO FORMY MNOGIEJ mimo koncowek 2/3/4 (ten sam
// wzorzec, co `ileKart` w magazyn-hurt.ejs i w faktury-hurtem-podglad.ejs).
//
// ⚠️ ODMIANA LICZY SIE W TRASIE, nie w widoku — i to jest caly powod, dla ktorego ta
// funkcja tu stoi (widok niczego nie liczy).
function ileKart(n) {
  const d = Math.abs(n) % 10;
  const s = Math.abs(n) % 100;
  if (n === 1) return `${n} karta`;
  return `${n} ${d >= 2 && d <= 4 && (s < 12 || s > 14) ? 'karty' : 'kart'}`;
}

// Jedno zdanie nad tabela: CO dzis zawęża liste. Sklada sie TUTAJ, bo widok niczego nie liczy.
//
// ⚠️ BEZ ZAWEZENIA MOWI LICZBA, A PRZY ZAWEZENIU JA POMIJA — i to nie jest oszczednosc.
// Liczbe wynikow pokazuje juz pasek filtrow („N kart" obok „Wyczyść zawężenie"), ktory
// renderuje sie DOKLADNIE wtedy, gdy cos zawęża. Ta sama liczba w dwoch miejscach zaczyna
// zyc wlasnym zyciem przy pierwszej zmianie jednego z nich.
function opisZawezenia(filtry, ile) {
  if (!saJakiesFiltry(filtry)) return `bez zawężenia · ${ileKart(ile)}`;
  // `Object.hasOwn`, a nie `MAPA[x] ?? domyslne`: klucz pochodzi z adresu HTTP. Przeszedl juz
  // przez biala liste `BRAKI_MAGAZYNU`, wiec ta bramka jest druga — i ma taka zostac.
  return filtry.brak && Object.hasOwn(BRAKI_ETYKIETY, filtry.brak)
    ? `zawężenie: ${BRAKI_ETYKIETY[filtry.brak]}`
    : 'zawężenie: filtry z paska';
}

// ================================================================================
// EKRAN POWIAZAN OFERT ALLEGRO Z KARTAMI PRODUKTOW
//
// Karta powstaje z katalogu SKLEPU; oferte wiaze sie z nia RECZNIE, bo `external` jest na
// Allegro puste we wszystkich 447 ofertach, a nazwy sa sprzedazowe. Miara podobienstwa
// siedzi w `domain/dopasowanie-ofert.js` — tutaj zostaje odczyt, kolejnosc i skladanie
// wierszy dla widoku.
//
// ⚠️⚠️ NIC NIE WIAZE SIE BEZ KLIKNIECIA (rozstrzygniecie wlasciciela). Trasa GET wylacznie
// CZYTA — zadnego „powiąż wszystkie pewne" jako skutku ubocznego wejscia na strone. Ocena
// jest PODPOWIEDZIA, a nie decyzja: zmierzone na prawdziwych danych, ze w kubelku 0,50–0,67
// siedza trafienia poprawne, wiec kazdy prog automatu wiazalby albo za duzo, albo za malo.

const BEZ_KART = {
  title: 'Magazyn — powiązania',
  naglowek: 'Najpierw karty, potem powiązania',
  // ⚠️ TO JEST STAN DZISIEJSZY PRODUKCJI, a nie przypadek krancowy: lustro ma 447 ofert
  // Allegro i ZERO kart, bo zakladanie kart to OSOBNY przycisk. Tabela z 447 wierszami
  // bez ani jednego kandydata wygladalaby jak zepsute dopasowanie — a to tylko brak katalogu.
  opis: 'Rejestr kart jest pusty, więc nie ma do czego przypinać ofert. Karta powstaje '
    + 'z katalogu sklepu: wejdź w Magazyn i kliknij „Odczytaj katalogi ze sklepów", a potem '
    + '„Utwórz karty z niepowiązanych". Dopiero wtedy ten ekran ma co proponować.',
};

// ⚠️ BIALA LISTA KOLEJNOSCI. Klucz z adresu HTTP → PORZADEK ROSNACY; `kier` odwraca.
// Komparatory, a nie SQL: kolejnosc po OCENIE da sie policzyc dopiero po policzeniu
// propozycji, wiec cala kolejnosc tego ekranu zyje w pamieci i musi zyc w JEDNYM miejscu.
//
// ⚠️⚠️ `Object.hasOwn`, NIGDY `SORTOWANIE[x] ?? domyslne`. Ta druga postac oddaje przy
// `?sort=constructor` FUNKCJE z `Object.prototype` (nie `undefined`), `??` jej nie zlapie,
// a `lista.sort(Object)` konczy sie pieciusetka — realna, zlapana przy Zadaniu 4 na
// glownym ekranie magazynu.
const SORTOWANIE_POWIAZAN = {
  nazwa: (a, b) => a.nazwa.localeCompare(b.nazwa, 'pl'),
  ocena: (a, b) => a.najlepsza - b.najlepsza,
  kanal: (a, b) => a.etykietaKanalu.localeCompare(b.etykietaKanalu, 'pl'),
};
const SORTOWANIE_POWIAZAN_DOMYSLNE = 'nazwa';

// ⚠️ Nierozpoznana nazwa kolejnosci WRACA DO DOMYSLNEJ, a nierozpoznany filtr po prostu
// NIE ZAWEZA — obie decyzje sa te same, co na ekranie magazynu, i z tego samego powodu:
// literowka w adresie ma pokazac liste, a nie pusty ekran. Pusty ekran przy 447 ofertach
// wyglada jak „nie ma czego wiazac".
const napis = (surowy) => (typeof surowy === 'string' && surowy.trim() ? surowy.trim() : null);
const kanalAllegro = (surowy) => {
  const s = napis(surowy);
  return s !== null && KANALY_ALLEGRO.includes(s) ? s : null;
};

/**
 * Numer karty z pola RECZNEGO.
 *
 * Pozycja wspolnej listy podpowiedzi ma postac „Nazwa karty [#123]" — bo przegladarka
 * filtruje `<datalist>` po WARTOSCI, nie po etykiecie, wiec sama liczba w `value` byla
 * niewyszukiwalna (nikt nie zna karty po numerze). Sam numer tez przyjmujemy: kto go zna,
 * ma go wpisac wprost.
 *
 * ⚠️ Napis, ktorego nie rozumiemy, oddaje `null` i konczy sie POMINIECIEM WIERSZA Z POWODEM
 * — nigdy zgadywaniem. Zgadniete powiazanie jest gorsze niz brak powiazania: to ono
 * rozstrzyga, z ktorej karty ida stan, wymiar i waga paczki.
 */
function numerKarty(surowy) {
  const zListy = /\[#(\d+)\]\s*$/u.exec(surowy);
  if (zListy) return Number(zListy[1]);
  const samaLiczba = /^\d+$/u.exec(surowy);
  return samaLiczba ? Number(samaLiczba[0]) : null;
}

/**
 * Pary (oferta → karta) z formularza. Oddaje `{ pary, pominiete }`.
 *
 * ⚠️ WPIS RECZNY BIJE ZAZNACZONEGO KANDYDATA. Radio zostaje zaznaczone po kliknieciu i bez
 * JavaScriptu nie da sie go odznaczyc; czlowiek, ktory najpierw kliknal podpowiedz, a potem
 * wpisal wlasny wybor, wyrazil zdanie DRUGIE. Odwrotna kolejnosc znaczylaby, ze wpisanie
 * czegokolwiek w pole reczne nie robi nic — po cichu.
 *
 * ⚠️ NIEZMIENNIK 4.13a: pominiete wracaja Z POWODEM i musza byc widoczne. Ciche wyrzucenie
 * wiersza z hurtu znaczyloby „zatwierdzilem czterdziesci, weszlo trzydziesci dziewiec".
 *
 * ⚠️ IDENTYFIKATORY BIERZEMY Z CIALA ZADANIA, ale nazwy i kolejnosc z ODCZYTANYCH list —
 * po pierwsze, po to, zeby oferta powiazana W MIEDZYCZASIE (przez druga karte) w ogole
 * doszla do warstwy zapisu i wrocila stamtad jako nieaktualna, zamiast zniknac po drodze;
 * po drugie, zeby wynik mowil NAZWAMI, a nie numerami wierszy.
 */
function paryZFormularza(body, oferty, karty) {
  const chciane = new Set();
  for (const klucz of Object.keys(body ?? {})) {
    const m = /^(?:karta|reczny)_(\d+)$/u.exec(klucz);
    if (m) chciane.add(Number(m[1]));
  }

  const znaneKarty = new Set(karty.map((w) => w.id));
  const pary = [];
  const pominiete = [];

  for (const o of oferty) {
    if (!chciane.has(o.id)) continue;
    chciane.delete(o.id);
    const reczny = String(body[`reczny_${o.id}`] ?? '').trim();
    const zListy = String(body[`karta_${o.id}`] ?? '').trim();
    const wybor = reczny || zListy;
    // Wiersz zostawiony na „nie wiążę" nie jest pominieciem — jest brakiem decyzji
    // i nie ma o czym meldowac.
    if (!wybor) continue;

    const kartaId = numerKarty(wybor);
    if (kartaId === null || !znaneKarty.has(kartaId)) {
      pominiete.push({ nazwa: o.nazwa, powod: `nie rozpoznałem karty „${wybor}"` });
      continue;
    }
    pary.push({ produktId: o.id, kartaId });
  }

  // Numer, ktorego nie ma juz w lustrze (odczyt katalogu wycofal oferte miedzy wyswietleniem
  // formularza a jego wyslaniem). Meldujemy numerem, bo nazwy nie znamy juz skad wziac.
  for (const id of chciane) {
    if (String(body[`reczny_${id}`] ?? '').trim() || String(body[`karta_${id}`] ?? '').trim()) {
      pominiete.push({ nazwa: `oferta #${id}`, powod: 'nie ma jej już w lustrze Allegro' });
    }
  }
  return { pary, pominiete };
}

/** Jeden wiersz ekranu powiazan, z policzonymi kandydatami. */
function wierszOferty(o, karty) {
  const lista = propozycje(o, karty);
  return {
    id: o.id,
    nazwa: o.nazwa,
    etykietaKanalu: adresKanalu(o.kanal),
    adres: adresSklepu(o.adres),
    // ⚠️ „Najlepsza ocena" sluzy WYLACZNIE kolejnosci. `-1` dla oferty bez kandydatow, zeby
    // przy kolejnosci malejacej spadala na dol — a nie mieszala sie z ocenami zerowymi,
    // ktorych ta miara i tak nie produkuje.
    najlepsza: lista.length ? lista[0].ocena : -1,
    kandydaci: lista.map((p) => ({
      id: p.karta.id,
      nazwa: p.karta.nazwa,
      sku: p.karta.sku || null,
      wymiary: opisWymiarow(p.karta),
      // ⚠️ PROCENT SKLADA SIE TUTAJ, a nie w widoku (widok w tym module niczego nie liczy).
      // I jest to JEDYNA etykieta oceny, jaka ekran pokazuje: slowa w rodzaju „pewne"
      // albo „słabe" odtworzylyby prog, ktory pomiar wlasnie obalil — w kubelku 0,50–0,67
      // siedza trafienia POPRAWNE, wiec nazwanie ich „słabymi" kazaloby je pomijac.
      procent: `${Math.round(p.ocena * 100)}%`,
      slowa: p.wspolneSlowa.join(', '),
    })),
  };
}

// Pozycja wspolnej listy podpowiedzi. JEDNA na strone, nie jedna na wiersz: 447 wierszy
// razy ~965 kart to megabajty HTML-a (rozstrzygniecie wlasciciela).
//
// ⚠️ NAZWA STOI W `value`, A NUMER W NAWIASIE NA KONCU — nie odwrotnie. Przegladarka
// filtruje `<datalist>` po WARTOSCI, nie po etykiecie, wiec numer w `value` dawalby liste
// niewyszukiwalna (nikt nie zna karty po numerze), a droga reczna przestawalaby istniec.
const pozycjaListy = (w) => ({
  wartosc: `${w.nazwa} [#${w.id}]`,
  opis: [w.sku, opisWymiarow(w)].filter(Boolean).join(' · '),
});

/**
 * Adres ekranu powiazan z PELNYM kompletem: fraza, filtr konta i kolejnosc.
 *
 * ⚠️ KAZDY ODNOSNIK EKRANU MA SIE SKLADAC TUTAJ, a nie od zera. Naglowek sortujacy budowany
 * jako `/magazyn/powiazania?sort=…` gubilby zawezenie, po ktorym wlasciciel wlasnie chcial
 * przejsc kilkanascie wierszy — to jest ten sam blad, ktory na liscie zamowien dawal
 * „przefiltrowana, ale ZUPELNIE INNA liste" (niezmiennik 4.13b).
 */
function adresPowiazan(filtry, { sort, kier, wroc = null } = {}) {
  const czesci = [];
  if (filtry?.fraza) czesci.push(['fraza', filtry.fraza]);
  if (filtry?.kanal) czesci.push(['kanal', filtry.kanal]);
  if (sort) czesci.push(['sort', sort]);
  if (kier) czesci.push(['kier', kier]);
  // ⚠️ ADRES POWROTU JEST CZESCIA KOMPLETU (4.13d), a nie doklejka przy odnosniku: ten ekran
  // ma wlasne filtry, szukajke i trzy naglowki sortujace, wiec powrot naprawiony wylacznie
  // w odnosniku dzialalby do PIERWSZEGO klikniecia w cokolwiek na stronie — a po to sie tu
  // wchodzi, zeby przejsc kilkanascie wierszy zawezeniem.
  if (wroc) czesci.push(['wroc', wroc]);
  if (!czesci.length) return '/magazyn/powiazania';
  return `/magazyn/powiazania?${czesci.map(([k, w]) => `${k}=${encodeURIComponent(w)}`).join('&')}`;
}

/**
 * Odnosniki sortujace naglowka RAZEM ze stanem „po tej kolumnie wlasnie sortujemy".
 *
 * ⚠️ Znacznik aktywnej kolumny nie jest ozdoba: nazwa spoza bialej listy WRACA DO DOMYSLNEJ,
 * wiec bez niego ekran pokazywalby jedna kolejnosc, a adres twierdzil drugie — i nikt by
 * tych dwoch rzeczy nie zestawil. `aria-sort` mowi to samo czytnikowi ekranu, co strzalka oku.
 */
function linkiPowiazan(sort, kier, filtry, wroc = null) {
  const przeciwny = kier === 'desc' ? 'asc' : 'desc';
  const linki = Object.create(null);
  for (const klucz of Object.keys(SORTOWANIE_POWIAZAN)) {
    const aktywna = klucz === sort;
    linki[klucz] = {
      adres: adresPowiazan(filtry, { sort: klucz, kier: aktywna ? przeciwny : 'asc', wroc }),
      aktywna,
      aria: aktywna ? (kier === 'desc' ? 'descending' : 'ascending') : null,
      strzalka: aktywna ? (kier === 'desc' ? '▼' : '▲') : '',
    };
  }
  return linki;
}

// Wartosci do przeniesienia UKRYTYMI POLAMI. `pomin` NIE JEST OZDOBA: formularz, ktory ma
// wlasne pole `kanal`, nie moze wyslac `kanal` drugi raz — Fastify oddaje wtedy TABLICE,
// parser slusznie odrzuca ja do `null`, i filtr znika dokladnie w tym formularzu, ktory
// sluzy do jego ustawiania.
function ukrytePowiazan(filtry, { sort, kier, wroc = null }, pomin = []) {
  const pary = [];
  if (filtry.fraza && !pomin.includes('fraza')) pary.push({ name: 'fraza', value: filtry.fraza });
  if (filtry.kanal && !pomin.includes('kanal')) pary.push({ name: 'kanal', value: filtry.kanal });
  // Kolejnosc NIE JEST filtrem, ale jedzie tymi samymi formularzami: bez tych dwoch pol
  // klikniecie „Filtruj" na liscie ulozonej po ocenie wracaloby do kolejnosci domyslnej.
  pary.push({ name: 'sort', value: sort }, { name: 'kier', value: kier });
  // Adres powrotu tez nie jest filtrem, a jedzie z tego samego powodu (4.13d): zawezenie
  // ekranu przezywa klikniecie „Filtruj", a powrot na zawezony magazyn ma przezyc tak samo.
  if (wroc) pary.push({ name: 'wroc', value: wroc });
  return pary;
}

// ================================================================================
// EKRAN JEDNEJ KARTY PRODUKTU
//
// Ekran karty jest stanowiskiem pracy przy JEDNEJ karcie: dane, komplet powiazanych produktow
// i ofert (z cenami, odnosnikami i zdjeciami) oraz dopisanie oferty Allegro.
//
// ⚠️⚠️ EKRAN KARTY JEST DOMYSLNIE DO ODCZYTU (wymaganie wlasciciela, wprost: „Dane karty z opisem
// nie da sie edytowac przed klknieciem przycisku «Edytuj»"). Formularz otwiera dopiero
// `?edytuj=dane`, BEZ JavaScriptu — dokladnie ten sam wzorzec, co trzy panele karty
// zamowienia (`zamowienie.ejs`: `?edytuj=wysylka|faktura|szczegoly`).
//
// ⚠️⚠️ EKRAN KARTY NIE ZAPISUJE NICZEGO DO SKLEPU ANI NA ALLEGRO. Zapis SKU i wymiarow
// do WooCommerce to Zadanie 15 i ma wlasny, obowiazkowy podglad. Tutaj nie ma prawa
// pojawic sie ani jedno zadanie modyfikujace do cudzego API — stad w calym tym module
// nie ma importu klienta sklepu ani Allegro (pilnuje tego test).

// Pola, ktore FORMULARZ KARTY wysyla. Wezsze niz `POLA_KARTY` w db/magazyn.js i tak ma byc:
// kolumny w milimetrach wypelnia wylacznie przeliczenie z centymetrow nizej, a nie ktos, kto dopisze pole do zadania HTTP.
//
// ⚠️ CZYTAMY WYLACZNIE PO TEJ LISCIE, a nie po kluczach ciala zadania — inaczej `?constructor`
// albo pole dopisane recznie do formularza siegaloby dalej, niz ekran pozwala.
const POLA_KARTY = Object.freeze(['nazwa', 'sku', 'kategoria_glowna', 'paczkomat', 'opis']);
const POLA_WYMIAROW = Object.freeze(['szerokosc_cm', 'wysokosc_cm', 'glebokosc_cm']);
const KOLUMNA_WYMIARU = Object.freeze({ szerokosc_cm: 'szerokosc_mm', wysokosc_cm: 'wysokosc_mm', glebokosc_cm: 'glebokosc_mm' });

// Wartosc pola formularza. `Object.hasOwn`, nie `body[k] ?? ''`: klucze pochodza z zadania
// HTTP, a na literale obiektu zapytanie o „constructor" oddaje funkcje z prototypu. Pole
// wyslane DWA RAZY wraca z Fastify jako TABLICA — `typeof === 'string'` odsiewa ja tutaj,
// a nie dwa poziomy nizej, przy wiazaniu parametru SQL.
function pole(body, klucz) {
  if (!body || !Object.hasOwn(body, klucz)) return null;
  const wartosc = body[klucz];
  return typeof wartosc === 'string' ? wartosc : null;
}

// Napis pola tekstowego → wartosc kolumny. Pusty daje `null`, nigdy pustego napisu: kolumna
// ma mowic „nie wiem", a nie „wiem, ze nic" — a przy `sku` (UNIQUE) pusty NAPIS odbilby sie
// o baze przy drugim takim karcie, podczas gdy NULL-e w UNIQUE sa wzajemnie rozne.
const doKolumny = (tekst) => (tekst.trim() ? tekst.trim() : null);

/**
 * Zmiany karty z formularza karty. Oddaje `{ zmiany, blad }`.
 *
 * ⚠️⚠️ ODMOWA JEST CALOSCIOWA. Jedno pole, ktorego nie rozumiemy, wstrzymuje CALY zapis —
 * a nie „to, co dalo sie odczytac". Polowiczny zapis zostawialby w bazie stan, o ktorym
 * ekran mowi „nie zapisalem", i nikt by juz nie wiedzial, ktora polowa weszla.
 *
 * ⚠️ PACZKOMAT JEDZIE SUROWY — normalizuje go `zapiszKarte` (`domain/paczkomat.js`, trzy stany).
 * Druga normalizacja tutaj rozjechalaby sie z tamta przy pierwszej zmianie, a to ona
 * rozstrzyga o filtrze „bez oznaczenia paczkomatu".
 */
function zmianyZFormularza(db, karta, body) {
  const zmiany = {};

  for (const klucz of POLA_KARTY) {
    const surowe = pole(body, klucz);
    // Pole, ktorego formularz nie przyslal, ZOSTAJE NIETKNIETE — brak pola to nie to samo,
    // co pole puste.
    if (surowe === null) continue;
    zmiany[klucz] = klucz === 'paczkomat' ? surowe : doKolumny(surowe);
  }

  // ⚠️ CENTYMETRY WCHODZA, MILIMETRY LADUJA W BAZIE — przelicza domena (`domain/rozmiar.js`),
  // bo to ta sama regula, ktora czyta rozmiar z nazwy produktu. `null` z niej znaczy „NIE
  // ROZUMIEM tego napisu" i jest CZYM INNYM niz `{ mm: null }` („skasuj wymiar"): ciche
  // zrownanie tych dwoch kasowaloby wymiar przy literowce, po cichu i na karcie, z ktorej
  // powstaje paczka, gabaryt i wymiar w sklepie.
  for (const klucz of POLA_WYMIAROW) {
    const surowe = pole(body, klucz);
    if (surowe === null) continue;
    const wynik = milimetryZCentymetrow(surowe);
    if (!wynik) {
      return {
        zmiany: null,
        blad: `„${surowe}" to nie jest wymiar w centymetrach. Wpisz samą liczbę `
          + '(np. 70 albo 10,5) albo zostaw pole puste, żeby skasować wymiar.',
      };
    }
    zmiany[KOLUMNA_WYMIARU[klucz]] = wynik.mm;
  }

  // PRZ-090: waga w KILOGRAMACH na karcie, w gramach w bazie — ta sama zasada „nie rozumiem” ≠ „skasuj”.
  const wagaSurowa = pole(body, 'waga_kg');
  if (wagaSurowa !== null) {
    const waga = gramyZKilogramow(wagaSurowa);
    if (!waga) {
      return { zmiany: null, blad: `„${wagaSurowa}" to nie jest waga w kilogramach. Wpisz samą liczbę `
        + '(np. 1,25) albo zostaw pole puste, żeby skasować wagę.' };
    }
    zmiany.waga_g = waga.g;
  }

  // ⚠️⚠️ WYMIAR POLOWICZNY NIE MA PRAWA POWSTAC. To NIE JEST nowa regula — to domkniecie
  // jedynej szczeliny w regule, ktora obowiazuje juz wszedzie indziej w tym module:
  // `opisWymiarow` oddaje dla polowicznego `null` („polowiczny wymiar to nadal brak
  // wymiarow"), filtr braków lapie go warunkiem `szerokosc_mm IS NULL OR wysokosc_mm IS NULL`,
  // a ekran pominietych liczy tak samo. Ekran karty byl JEDYNYM miejscem, ktore potrafilo taki
  // stan ZAPISAC — i robil to kodem 303, czyli meldujac sukces.
  //
  // ⚠️ CZYM TO GROZI, ODKAD ISTNIEJE EDYCJA HURTEM: karta z sama szerokoscia wpada do filtru
  // „bez wymiarów", czyli dokladnie w zawezenie, po ktorym idzie hurt. Hurt ustawilby jej
  // 70×100, KASUJAC jedyna zmierzona wartosc — przy 645 wierszach naraz i bez cofniecia.
  // Hurt zachowuje sie przy tym poprawnie (bierze to, co filtr uznal za brak); to ekran karty
  // wpuszczala do rejestru stan, ktorego reszta modulu nie uznaje za istniejacy.
  //
  // ⚠️ ROZSTRZYGA STAN PO ZAPISIE, a nie „ile pol przyslal formularz". Zadanie niosace SAMA
  // szerokosc na karcie, ktora wysokosc juz ma, daje pare KOMPLETNA i ma przejsc — inaczej
  // ta bariera blokowalaby poprawienie jednego wymiaru. Dlatego patrzymy na `zmiany`
  // NALOZONE na karte, a nie na same pola zadania.
  const poZapisie = (kolumna) => (
    Object.hasOwn(zmiany, kolumna) ? zmiany[kolumna] : (karta?.[kolumna] ?? null)
  );
  const szerokoscPoZapisie = poZapisie('szerokosc_mm');
  const wysokoscPoZapisie = poZapisie('wysokosc_mm');
  // Oba wypelnione — dobrze. Oba puste — tez dobrze, to SWIADOME wyczyszczenie wymiaru
  // i zachowanie karty, ktore ma zostac. Odmawiamy WYLACZNIE mieszance.
  if ((szerokoscPoZapisie === null) !== (wysokoscPoZapisie === null)) {
    const brakujacy = szerokoscPoZapisie === null ? 'szerokości' : 'wysokości';
    return {
      zmiany: null,
      blad: `Wymiar musi mieć obie liczby albo żadnej — brakuje ${brakujacy}. Do paczki `
        + 'i do sklepu potrzebne są oba, więc karta z jedną liczbą i tak trafia na listę „bez wymiarów", '
        + 'gdzie edycja hurtem nadpisze ją razem z resztą. Podaj oba wymiary albo zostaw '
        + 'oba pola puste.',
    };
  }

  // Nazwa jest jedynym polem OBOWIAZKOWYM (kolumna `NOT NULL`) — i slusznie: karta bez nazwy
  // nie da sie ani znalezc na liscie, ani dopasowac do oferty.
  if (Object.hasOwn(zmiany, 'nazwa') && zmiany.nazwa === null) {
    return { zmiany: null, blad: 'Karta musi mieć nazwę — bez niej nie da się jej znaleźć ani dopasować do oferty.' };
  }

  // ⚠️ SKU SPRAWDZAMY PRZED ZAPISEM, ZEBY ODMOWA BYLA ZDANIEM, a nie pieciusetka z bazy
  // (kolumna jest `UNIQUE`, wiec ostatecznym straznikiem zostaje ona — patrz `kartaZeSku`).
  if (zmiany.sku) {
    const zajete = kartaZeSku(db, zmiany.sku);
    // Wlasne SKU przepuszczamy: bez tego zapis czegokolwiek innego na karcie odbijalby sie
    // o numer, ktory ta karta ma od dawna.
    if (zajete && zajete.id !== karta.id) {
      return {
        zmiany: null,
        blad: `SKU „${zmiany.sku}" jest już zajęte — używa go karta „${zajete.nazwa}" (#${zajete.id}).`,
      };
    }
  }

  return { zmiany, blad: null };
}

// Adres powrotu na liste (Zadanie 6). WYLACZNIE wlasny ekran magazynu — wartosc przychodzi
// z paska adresu (albo od kogos, kto podesle spreparowany odnosnik), wiec bez tej bariery
// karta bylaby przekaznikiem na DOWOLNY adres (open redirect), a `//host` przegladarka
// czyta jako adres absolutny bez schematu (`//evil.example` == `https://evil.example`
// na stronie serwowanej po https).
const bezpiecznyWroc = (surowy) => (
  typeof surowy === 'string' && /^\/magazyn(\?|$)/.test(surowy) && !surowy.includes('//')
    ? surowy : null
);

// Adres karty z PELNYM kompletem stanu ekranu: otwarta sekcja edycji, fraza, filtr konta
// i — od Zadania 6 — adres powrotu na liste (`wroc`, JUZ zwalidowany przez `bezpiecznyWroc`
// u kazdego wywolujacego). ⚠️ Ten sam powod, co przy `adresMagazynu` i `adresPowiazan`
// (niezmiennik 4.13b): odnosnik budowany od zera gubilby to, co czlowiek przed chwila
// ustawil — a tu gubilby TAKZE otwarty formularz i to, na jaka liste ma wrocic.
//
// ⚠️ `wroc` DOKLEJA SIE JAKO OSTATNI — kolejnosc parametrow ma zostac STALA (ta sama zasada,
// co przy `POLA` w domain/magazyn-filtry.js), zeby ten sam stan ekranu mial zawsze ten sam
// adres (zakladki, historia przegladarki, testy porownujace adresy).
function adresKarty(id, {
  edytuj, fraza, kanal, wroc,
} = {}) {
  const czesci = [];
  if (edytuj) czesci.push(['edytuj', edytuj]);
  if (fraza) czesci.push(['fraza', fraza]);
  if (kanal) czesci.push(['kanal', kanal]);
  if (wroc) czesci.push(['wroc', wroc]);
  if (!czesci.length) return `/magazyn/${id}`;
  return `/magazyn/${id}?${czesci.map(([k, w]) => `${k}=${encodeURIComponent(w)}`).join('&')}`;
}

// Dokleja „?wroc=…" do GOLEJ sciezki (bez reszty parametrow, ktorych „/odepnij" i „/powiaz"
// nie znaja — patrz pulapka sklejania przy `adresOdepnij`/`adresPowiaz` w `ekranKarty`).
// To ten sam encoding, co `wroc` wewnatrz `adresKarty` — wyciagniety, zeby nie zyl osobno
// w kazdym z tamtych dwoch miejsc.
const zWroc = (sciezka, wroc) => (
  wroc ? `${sciezka}?wroc=${encodeURIComponent(wroc)}` : sciezka
);

// ================================================================================
// EDYCJA HURTEM — WYMIARY, KATEGORIA GLOWNA, PACZKOMAT, SKROCENIE NAZWY
//
// PO CO TO JEST (zmierzone na produkcji 2026-08-12): 645 kart bez wymiaru, 965 bez
// oznaczenia paczkomatu, 152 bez kategorii glownej. Wlasciciel potwierdzil, ze wiekszosc
// produktow ze sklepu A ma TEN SAM wymiar 70×100 cm. Bez tego ekranu trzeba by otworzyc
// 645 kart po kolei.
//
// ⚠️⚠️ PUSTE POLE ZNACZY „NIE RUSZAJ", ODWROTNIE NIZ NA KARCIE — cale rozstrzygniecie stoi
// w `domain/magazyn-hurt.js`, razem z powodem. Tutaj zostaje wylacznie droga.
//
// ⚠️⚠️ PODGLAD JEST OBOWIAZKOWY I JEST OSOBNA TRASA. `POST /magazyn/hurt` WYLACZNIE liczy
// i pokazuje; zapisuje dopiero `POST /magazyn/hurt/zatwierdz`. Jedna trasa z polem
// „czy na pewno" znaczylaby, ze pomylka w tym polu zapisuje 645 kart bez pokazania czego
// — a to jest ta sama zasada, ktora obowiazuje faktury hurtem i zapis do sklepow.
//
// ⚠️⚠️ ZESTAW ZMIAN LICZONY PONOWNIE PRZY ZATWIERDZENIU. Formularz podgladu przynosi
// IDENTYFIKATORY i WARTOSCI (decyzja czlowieka), nigdy gotowego „z czego na co": odczyt
// katalogow albo druga karta miedzy podgladem a kliknieciem zmienilyby zbior po cichu.
//
// ⚠️ ANI JEDNEGO ZADANIA DO SKLEPU CZY ALLEGRO. Zapis SKU i wymiarow do WooCommerce to
// Zadanie 15 z wlasnym podgladem — stad w calym tym module nie ma importu klienta sklepu
// (pilnuje tego test).

/**
 * Numery zaznaczonych kart z ciala zadania.
 *
 * ⚠️⚠️ SMIEC NIE POSZERZA ZBIORU. Napis, ktorego nie rozumiemy, po prostu WYPADA — nigdy nie
 * zamienia sie w „wszystkie". Pole wyboru wysyla `zaznaczone` raz na zaznaczony wiersz, wiec
 * przy jednym zaznaczeniu Fastify oddaje NAPIS, a przy kilku TABLICE; oba ksztalty musza
 * znaczyc to samo, bo inaczej zaznaczenie jednej karty dzialaloby inaczej niz szescuset.
 *
 * ⚠️ SAME CYFRY, a nie „co da sie przerobic na liczbe" — ta sama regula, co w `kartaPoId`.
 */
function numeryZaznaczone(surowe) {
  const numery = [];
  for (const s of (Array.isArray(surowe) ? surowe : [surowe])) {
    if (typeof s !== 'string' || !/^\d+$/u.test(s)) continue;
    const n = Number(s);
    if (Number.isSafeInteger(n) && n > 0) numery.push(n);
  }
  return numery;
}

/**
 * Zawezenie listy przeniesione przez formularz hurtowy — JEDNYM polem, nie siedmioma.
 *
 * ⚠️⚠️ I TO JEST POWOD, DLA KTOREGO POLE JEST JEDNO. Formularz hurtowy ma WLASNE pole
 * `paczkomat` (wartosc DO USTAWIENIA), a filtr ma pole `paczkomat` (czym ZAWEZIC). Te same
 * nazwy w jednym formularzu wracaja z Fastify jako TABLICA — parser slusznie ja odrzuca,
 * wiec zawezenie i ustawiana wartosc kasowalyby sie nawzajem, i to akurat na drodze
 * TYPOWEJ („zawez do nieoznaczonych, ustaw «nie»"). Jedno pole zbiorcze rozdziela oba
 * slowniki RAZ, a nie do nastepnego dopisanego filtru.
 *
 * ⚠️ `Object.create(null)`, bo klucze pochodza z adresu HTTP: na literale obiektu zapytanie
 * o „constructor" siegnaloby do prototypu (ta sama pulapka, co przy bialych listach wyzej).
 * Klucz powtorzony bierzemy PIERWSZY i tylko raz — tablica nie ma jak powstac.
 */
function filtryZawezenia(surowe) {
  const query = Object.create(null);
  if (typeof surowe === 'string' && surowe) {
    for (const [klucz, wartosc] of new URLSearchParams(surowe)) {
      if (!Object.hasOwn(query, klucz)) query[klucz] = wartosc;
    }
  }
  return filtryZZapytania(query);
}

// Dwa zakresy i ANI JEDNEGO domyslnego „wszystko". Nierozpoznana wartosc spada do
// zaznaczenia — czyli do zbioru WEZSZEGO, nigdy szerszego.
const zakresHurtu = (surowy) => (surowy === 'pasujace' ? 'pasujace' : 'zaznaczone');

const HURT_BEZ_ZAZNACZENIA = 'Nie zaznaczono ani jednej karty, więc nic nie zmieniłem. '
  + 'Zaznacz karty na liście albo kliknij przycisk „dla wszystkich pasujących" — stoi przy tej samej akcji i podaje, ilu kart dotyczy.';
const HURT_BEZ_ZMIANY = 'Nie wybrałeś, co zmienić — wszystkie pola formularza są puste. '
  + 'Puste pole hurtem znaczy „nie ruszaj tej kolumny", więc nie było czego zapisać.';

  return { kartyZKanalami, produktyPominiete, utworzKartyZNiepowiazanych, kategorieDoFiltra, SORTOWANIE_KART, niepowiazaneOfertyAllegro, powiazaneOfertyAllegro, kartyDoPowiazania, powiazOfertyHurtem, odepnijOferte, kartaPoId, produktyKarty, kartaZeSku, zapiszKarte, kartyPoIdach, zastosujHurtem, zajeteSku, nadajSku, produktyKart, zapiszSkuSklepu, zliczeniaBrakow, zliczeniaNiepowiazanych, polecenieZFormularza, zmianyHurtem, polaDoPrzeniesienia, proponujSku, przejeciaZeSklepu, ocenZapis, jednostkiSklepow, wyslijDoSklepow, propozycje, propozycjeOfert, KANALY_ALLEGRO, grupujPominiete, filtryZZapytania, saJakiesFiltry, parametryUkryte, wartosciPol, adresMagazynu, KANALY_MAGAZYNU, PACZKOMAT_DO_FILTRA, BRAKI_ETYKIETY, PACZKOMAT_ETYKIETY, adresKanalu, KANALY_SKLEPOW, miniaturaZLustra, opisWymiarow, centymetryZMilimetrow, milimetryZCentymetrow, czyPaczkomat, zl, fmtDataCzas, KOLUMNY_KANALOW, POLA_FORMULARZA_FILTROW, NAGLOWKI_KANALOW, BEZ_SKLEPOW, BEZ_SKLEPOW_ODMOWA, ADRES_HTTP, adresSklepu, zapisanaMiniatura, komorkaKanalu, zEtykietaKanalu, opisLiczbyKanalow, opisPrzebiegu, linkiSortowania, kafleBrakow, wierszKarty, ileKart, opisZawezenia, BEZ_KART, SORTOWANIE_POWIAZAN, SORTOWANIE_POWIAZAN_DOMYSLNE, napis, kanalAllegro, numerKarty, paryZFormularza, wierszOferty, pozycjaListy, adresPowiazan, linkiPowiazan, ukrytePowiazan, POLA_KARTY, POLA_WYMIAROW, pole, doKolumny, zmianyZFormularza, bezpiecznyWroc, adresKarty, zWroc, numeryZaznaczone, filtryZawezenia, zakresHurtu, HURT_BEZ_ZAZNACZENIA, HURT_BEZ_ZMIANY };
}
