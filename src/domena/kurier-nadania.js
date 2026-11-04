import { metodaWysylki, czyPobranie, metodaZeSklepu, pobranieZeSklepu } from './wysylka.js';
import {
  MODULY_KURIEROW, kurierDlaMetody, metodyNaUmowie, metodyZZpl, pobranieNaUmowie, pobranieNaDosylce,
} from './moduly-kurierow.ts';
import { czyKanalWbudowany } from './kanaly.js';

/**
 * PRZ-137.01 (D1, decyzja właściciela 03.11): „pobranie ze sklepu" — sklep SPRZEDAŁ tę dostawę za
 * pobraniem i nikt w OMS-ie nie zmienił ani metody, ani pobrania. Takie pobranie jedzie
 * z kwotą niezależnie od przełącznika „umowa na pobranie" — skoro sklep ma tę metodę aktywną,
 * firma ma ją u kuriera. Punktu odbioru NIE porównujemy: poprawiona skrytka to ta sama umowa.
 *
 * ⚠️ Brak kanału (`sklep` puste) = NIE sklepowe: przełącznik obowiązuje, czyli surowiej.
 */
export function pobranieSklepowe(z) {
  const kanal = String(z?.sklep ?? '').trim();
  if (!kanal || czyKanalWbudowany(kanal)) return false;
  return pobranieZeSklepu(z) && czyPobranie(z) && metodaWysylki(z) === metodaZeSklepu(z);
}

/**
 * PRZ-137.01 (D2): czy nadanie TĄ metodą wymaga włączonej umowy firmy na pobranie. `true`
 * WYŁĄCZNIE dla pobrania OMS-owego (ręczne, zmienione na karcie) u kuriera z pobraniem
 * 'adapter' w rejestrze, gdy firma nie zaznaczyła umowy. Kurier 'umowa' (DPD, WzA) — nigdy;
 * 'brak' odmawia gdzie indziej.
 * PRZ-137.03 (D2): `zamiennik` — pobranie na paczce N > 1 to ZAWSZE pobranie OMS-owe (decyzja
 * operatora, nie sklepu), więc „pobranie ze sklepu" go nie zwalnia z umowy.
 */
export function wymagaUmowyPobrania(z, metoda, rejestr = MODULY_KURIEROW, umowy = /** @type {readonly string[]} */ ([]), { zamiennik = false } = {}) {
  if (!czyPobranie(z) || (!zamiennik && pobranieSklepowe(z))) return false;
  const kurier = kurierDlaMetody(metoda, rejestr);
  if (kurier === null || rejestr[kurier]?.umiejetnosci?.pobranie !== 'adapter') return false;
  return !pobranieNaUmowie(metoda, rejestr, umowy);
}

/**
 * PRZ-137.02 (D2): powód odmowy, gdy `wymagaUmowyPobrania` daje `true` — JEDEN tekst dla hurtu
 * (masowe.js) i karty (services/nadanie.js, ostrzeżenie w nadaj.ejs). Nazwa kuriera z rejestru,
 * bez założenia, że zostaje DPD. Mała litera na początku (hurt wstawia go jako powód pominięcia).
 */
export function powodUmowyPobrania(metoda, rejestr = MODULY_KURIEROW) {
  const kurier = kurierDlaMetody(metoda, rejestr);
  const nazwa = (kurier !== null && rejestr[kurier]?.nazwa) || 'tego kuriera';
  return `pobranie przez ${nazwa} wymaga umowy — włącz ją w Ustawieniach → Integracje albo zmień kuriera na karcie zamówienia`;
}

/**
 * PRZ-137.03 (D2, D3): powód odmowy zamiennika za pobraniem (paczka N > 1, zaznaczone pobranie
 * na tej paczce) tą metodą albo `null`, gdy wolno. Kurier bez `pobranieNaDosylce` → tekst
 * neutralny D3 (bez założenia, który kurier zostaje); kurier 'adapter' bez umowy firmy → ten sam
 * powód co przy paczce nr 1. Mała litera na początku, jak `powodUmowyPobrania`.
 */
export function powodOdmowyZamiennika(z, metoda, {
  rejestr = MODULY_KURIEROW, umowyPobrania = /** @type {readonly string[]} */ ([]),
} = {}) {
  if (!czyPobranie(z)) return null;
  if (!pobranieNaDosylce(metoda, rejestr)) {
    const kurier = kurierDlaMetody(metoda, rejestr);
    const nazwa = (kurier !== null && rejestr[kurier]?.nazwa) || 'ten kurier';
    return `${nazwa} nie przyjmie pobrania na kolejnej paczce — wybierz kuriera, który je przyjmuje, albo wyłącz pobranie na tej paczce`;
  }
  if (wymagaUmowyPobrania(z, metoda, rejestr, umowyPobrania, { zamiennik: true })) return powodUmowyPobrania(metoda, rejestr);
  return null;
}

// Kurier, ktorym NADAJEMY te konkretna paczke — a nie metoda, ktora klient wybral kupujac.
//
// ⚠️ ISTNIEJE DLA JEDNEGO PRZYPADKU I WARTO GO ZNAC (zgloszenie wlasciciela 2026-08-07):
// zamowienie przyszlo z Allegro, pierwsza paczka pojechala etykieta kupiona w panelu
// Allegro, a teraz trzeba doslac brakujacy produkt WLASNYM kurierem. Panel tego nie
// potrafil i — co gorsza — KLAMAL: karta pokazywala przycisk „Nadaj paczke", ekran nadania
// wypelnial komplet pol, a zatwierdzenie odbijalo sie o `wybierzKuriera` komunikatem
// „Metoda «allegro_dpd» nie jest obslugiwana w tym panelu" — juz PO zapakowaniu paczki.
//
// ⚠️ BARIERA, KTORA TO ODBIJALA, NIE JEST PRZEOCZENIEM I NIE WOLNO JEJ ZDJAC. Chroni przed
// nadaniem DRUGIEJ, PLATNEJ paczki do klienta, ktory swoja juz dostal — a token Allegro ma
// prawo nadawania, wiec po tamtej stronie nie chroni nas NIC. Ten modul bariery nie usuwa:
// zamienia ja z „nie da sie nigdy" na „da sie WYLACZNIE po swiadomym wskazaniu czlowieka".
//
// ⚠️⚠️ GDZIE TA BARIERA STOI — ZMIENILO SIE 18.09.2026. Byla brakiem metod allegrowych
// w `DLA_METODY` (kurierzy/index.js), czyli dzialala na zgrubnej KATEGORII metody. Odkad
// `allegro_punkt`, `allegro_kurier` i `allegro_inne` prowadza do adaptera WzA, prawdziwa
// odmowa siedzi w `wolnoNadacZOms` (domain/allegro-wysylka.js) i pyta o KONKRETNY
// identyfikator uslugi z ZYWEGO odczytu zamowienia. Bariera jest wiec wezsza i celniejsza,
// a nie slabsza: kategorie zgadujemy my, identyfikator przychodzi z Allegro.
// ⛔ Czesc, ktora sie NIE ruszyla: `allegro_paczkomat` dalej nie ma wpisu w `DLA_METODY`,
// bo uslugi InPostu maja `owner: CLIENT`, czyli NASZA umowe.
//
// ⚠️ DLACZEGO NIE „PRZESTAW METODE NA KARCIE Z allegro_dpd NA dpd". Ta droga dzialala
// i wlasnie dlatego jest zla: `wysylka_reczna_json` to nadpisanie TRWALE, wiec zamowienie
// na zawsze klamaloby, ze klient wybral nasze DPD; przestaloby tez byc rozpoznawalne po
// metodzie w nadaniu zbiorczym (domain/masowe.js pilnuje OBU siatek — kanalu i metody —
// wlasnie z tego powodu). Wybor z ekranu nadania jest JEDNORAZOWY: dotyczy tej paczki,
// niczego nie zapisuje do zamowienia. Ta sama rodzina co kod paczkomatu i kwota pobrania.

/**
 * Metody, ktore panel umie nadac SAM (NASZA umowa) — PRZ-135.04a: z rejestru kurierow, metody
 * kurierow z `umowa: 'wlasna'` w kolejnosci rejestru (dzis DPD, paczkomat InPost), z etykieta
 * wyboru (`etykietaWyboru`, zapasowo `etykieta`). Podzbior metod z kurierem z definicji.
 */
const doWyboru = (rejestr) => metodyNaUmowie('wlasna', rejestr)
  .map((m) => ({ klucz: m.klucz, etykieta: m.etykietaWyboru ?? m.etykieta }));

/**
 * Czy to zamowienie wymaga, zeby czlowiek WSKAZAL kuriera, zanim panel cokolwiek nada.
 *
 * ⚠️ Liczone po METODZIE, a nie po kanale (`czyKanalAllegro`) — i tu, wyjatkowo, tak ma byc.
 * Kanal odpowiada na pytanie „czyja to sprzedaz" i tym pilnuje sie odmow (masowe.js,
 * sync-sklep.js). Tutaj pytanie brzmi „czy panel wie, czym to wyslac", a na nie odpowiada
 * wylacznie metoda: `allegro_paczkomat` nie ma wpisu w `DLA_METODY` niezaleznie od tego,
 * z ktorego konta przyszlo. Kierunek jest przy tym bezpieczny: metoda przestawiona recznie
 * na `dpd` wychodzi z tego warunku, ale wpada w ten sam `wybierzKuriera` co zawsze.
 */
// ⚠️⚠️ PACZKOMAT Z ALLEGRO NADAJEMY MY, I TO NIE JEST WYJATEK OD BARIERY, TYLKO JEJ
// WLASCIWY ZAKRES (07.08.2026, wlasciciel wprost: „Paczka paczkomat allegro nadawana ma byc
// przez OMS. Tak jest teraz w Apilo. Nie da sie jej nadac przez allegro").
//
// Bariera istnieje po to, zeby panel nie nadal DRUGIEJ, PLATNEJ paczki do klienta, ktory
// swoja juz dostal — a ryzyko drugiej paczki bierze sie STAD, ZE ALLEGRO POTRAFI SPRZEDAC
// ETYKIETE na te sama przesylke. Przy paczkomacie Allegro etykiety NIE SPRZEDAJE, wiec
// pierwszej paczki z tamtej strony po prostu nie ma i nie ma czego dublowac. Pierwsza wersja
// (rano 07.08) pytala o kuriera przy KAZDEJ metodzie allegrowej i byla przez to zbyt szeroka:
// dokladala klikniecie do sciezki, w ktorej nie ma zadnej niejednoznacznosci.
//
// ⚠️ POZOSTALE METODY ALLEGROWE ZOSTAJA PRZY BARIERZE — czyli przechodza przez pytanie
// o kuriera, zamiast byc nadawane automatycznie nasza umowa.
//
// ⚠️⚠️ ZDANIE „panel nie umie ich nadac" BYLO PRAWDZIWE I PRZESTALO BYC 18.09.2026.
// `allegro_punkt`, `allegro_kurier` i `allegro_inne` maja od tego dnia droge domyslna
// („Wysylam z Allegro") i osiem uslug w `METODY_WZA` — ORLEN, DHL, One Box. Przy barierze
// zostaja z innego powodu niz wtedy: nie dlatego, ze panel ich nie umie, tylko dlatego,
// ze wskazanie czlowieka ma dalej rzadzic — to jest furtka na DOSYLKE nasza umowa
// (zamiennik za zgubiona), ktorej `NADAJEMY_SAMI` by odebralo.
// PRZ-135.04a: ta mapa zostaje JAWNA (regula pieniedzy, nie dane kuriera). Cel musi byc metoda
// kuriera na NASZEJ umowie z rejestru — inaczej panel nie wystartuje, zamiast cicho odmawiac.
const NADAJEMY_SAMI = { allegro_paczkomat: 'inpost_paczkomat' };
for (const [metoda, cel] of Object.entries(NADAJEMY_SAMI)) {
  if (!metodyNaUmowie('wlasna').some((m) => m.klucz === cel)) {
    throw new Error(`NADAJEMY_SAMI: ${metoda} → ${cel}, a ${cel} nie jest metodą kuriera na własnej umowie w rejestrze`);
  }
}

// ⚠️⚠️ `allegro_dpd` PRZESTAL WYMAGAC WSKAZANIA KURIERA (11.08.2026, plan „Wysylam z Allegro").
//
// Zdanie wyzej — „`allegro_dpd` zostaje przy barierze, bo tam etykieta z Allegro istnieje" —
// bylo PRAWDZIWE i przestalo byc. Etykieta z Allegro dalej istnieje, ale od tego zadania
// KUPUJE JA PANEL (kurierzy/allegro-wza.js), na umowie Allegro i ta sama usluga, ktora wybral
// kupujacy. Ryzyko, przed ktorym stala bariera, nie znikneło — przenioslo sie: druga paczka
// grozi teraz nie z pomylki kuriera, tylko z etykiety kupionej RECZNIE w panelu Allegro.
// Broni przed tym osobne sprawdzenie w adapterze (`GET .../shipments` przed zakupem).
//
// ⚠️ TO NIE JEST WPIS DO `NADAJEMY_SAMI` — i ta roznica jest cala. `NADAJEMY_SAMI` IGNORUJE
// wskazanie czlowieka, wiec wpisanie tam `allegro_dpd` zabraloby furtke na DOSYLKE nasza
// umowa („zamiennik za zgubiona"), ktora komunikat nizej wprost obiecuje. Tutaj wskazanie
// dalej rzadzi — zmienia sie WYLACZNIE to, co dzieje sie przy jego BRAKU: dotad odmowa,
// teraz „Wysylam z Allegro".
// ⚠️⚠️ TRZY METODY DOSZLY 18.09.2026 razem z osmioma uslugami w `METODY_WZA`.
//
// `allegro_inne` to WOREK na wszystko, czego slownik nie umie nazwac — i wpuszczenie go tutaj
// wyglada na rozszczelnienie bariery. Nie jest, bo BARIERA NIE STOI JUZ W TEJ MAPIE.
// Ta mapa odpowiada tylko na pytanie „ktora droga jest domyslna dla tej KATEGORII metody";
// prawdziwa odmowa siedzi w `wolnoNadacZOms` i pyta o KONKRETNY identyfikator uslugi
// z ZYWEGO odczytu zamowienia. Nieznana usluga Allegro odbije sie wiec tam — glosno
// i po identyfikatorze, a nie po zgrubnej kategorii, ktora Allegro moze przypisac inaczej.
//
// ⛔ `allegro_paczkomat` CELOWO TU NIE MA — siedzi w `NADAJEMY_SAMI` i ma tam zostac
// (decyzja właściciela 18.09: „oprocz paczkomatow"). Uslugi InPostu maja w katalogu Allegro
// `owner: CLIENT`, czyli NASZA umowe: nadanie ich „przez Allegro" bylo by drugim, platnym
// przewozem do klienta, ktory swoj ma juz oplacony.
//
// PRZ-135.04a: lista = metody kuriera z `umowa: 'platformy'` w rejestrze (dzis WzA: allegro_dpd,
// allegro_punkt, allegro_kurier, allegro_inne). Usuniecie metody tam = odmowa jej nadania tu.
const wzaDomyslnie = (rejestr) => Object.fromEntries(
  metodyNaUmowie('platformy', rejestr).map((m) => [m.klucz, m.klucz]),
);
const WZA_DOMYSLNIE = wzaDomyslnie(MODULY_KURIEROW);

export function wymagaWyboruKuriera(z) {
  const metoda = String(metodaWysylki(z) ?? '');
  if (!metoda.startsWith('allegro_')) return false;
  return !Object.hasOwn(NADAJEMY_SAMI, metoda);
}

/**
 * Kurierzy, ktorych wolno wskazac dla TEJ paczki tego zamowienia.
 *
 * ⚠️ PRZY POBRANIU NA PACZCE NR 1 ZOSTAJE SAM DPD — i to jest ochrona pieniedzy, nie
 * ostroznosc. Pobranie paczkomatowe jest w panelu ZBUDOWANE, ale UMOWA Z INPOSTEM NA NIE
 * NIE ZOSTALA POTWIERDZONA (rozpoznanie 01.08.2026: wszystkie 44 przesylki konta maja `cod`
 * puste, a lista uslug organizacji nie ma wariantu pobraniowego). Wskazanie paczkomatu dla
 * zamowienia za pobraniem moglo by wiec dac przesylke, przy ktorej InPost nie zainkasuje
 * NIC — czyli towar oddany za darmo, bez ani jednego bledu po drodze.
 *
 * Na paczce N > 1 pobranie DOMYSLNIE nie jedzie, wiec tam wybor jest pelny — i wlasnie
 * dlatego warunek nie pyta o samo `czyPobranie`: dosylka do zamowienia pobraniowego to
 * najzwyklejszy przypadek uzycia tego ekranu.
 *
 * ⚠️⚠️ ALE OD 04.09.2026 „N > 1" NIE ZNACZY JUZ „bez pobrania". Operator moze kazac pobraniu
 * pojechac na paczce N > 1, gdy jest ona ZAMIENNIKIEM pierwszej (wyrzucona etykieta —
 * uzasadnienie przy warunku <cod> w kurierzy/dpd.js). Dyskryminatorem jest wiec „czy pobranie
 * jedzie na TEJ paczce", a NIE jej numer. Gdyby zostal numer, powstalaby droga: zamiennik za
 * pobraniem przez paczkomat → InPost nie inkasuje NIC → towar oddany za darmo, bez ani
 * jednego bledu po drodze. To jest ta sama ochrona pieniedzy, co przy paczce nr 1, tylko
 * kluczowana faktem zamiast numeru.
 */
// ⚠️⚠️ DROGA DOMYSLNA MUSI BYC NA LISCIE WYBORU (11.08.2026, po pierwszej probie nadania).
//
// `WZA_DOMYSLNIE` sprawilo, ze BRAK wskazania prowadzi do „Wysylam z Allegro" — ale ekran
// nadania kaze wybrac pozycje Z LISTY, a lista znala wylacznie naszych kurierow. Skutek:
// jedyne, co dalo sie kliknac, to nadanie NASZA umowa, czyli drugi platny przewoz do
// klienta, ktory ma juz oplacona dostawe. Reguła bez wpisu w tej liscie jest niedostepna —
// i to jest ta sama lekcja, co „ekran nie jest bariera": ekran nie jest tez DROGA.
// ⚠️ KAZDA metoda z `WZA_DOMYSLNIE` MUSI miec tu wpis — inaczej droga domyslna jest
// NIEDOSTEPNA z ekranu i jedyne, co da sie kliknac, to nadanie nasza umowa, czyli drugi
// platny przewoz (lekcja z 11.08.2026, opisana nad ta stala). Test-straznik pilnuje, ze obie
// mapy maja te same klucze.
const ETYKIETA_WZA = 'Wysyłam z Allegro — umowa Allegro (domyślnie)';
const wzaDoWyboru = (rejestr) => Object.fromEntries(
  Object.keys(wzaDomyslnie(rejestr)).map((metoda) => [metoda, { klucz: 'wza', etykieta: ETYKIETA_WZA }]),
);

// Reguly liczone raz na rejestr: produkcyjny przy imporcie, testowy (podany parametrem) przy wywolaniu.
const REGULY = new WeakMap();
function regulyNadania(rejestr) {
  let r = REGULY.get(rejestr);
  if (!r) {
    r = { doWyboru: doWyboru(rejestr), wzaDoWyboru: wzaDoWyboru(rejestr) };
    REGULY.set(rejestr, r);
  }
  return r;
}

export function kurierzyDoWyboru(z, kolejnosc = 1, {
  pobranieNaTejPaczce = kolejnosc === 1, rejestr = MODULY_KURIEROW, umowyPobrania = /** @type {readonly string[]} */ ([]),
} = {}) {
  const { doWyboru: DO_WYBORU, wzaDoWyboru: WZA_DO_WYBORU } = regulyNadania(rejestr);
  // ⚠️ WzA IDZIE PIERWSZE i tak ma zostac: przy zamowieniu z Allegro to jest droga wlasciwa,
  // a nasza umowa jest wyjatkiem (dosylka, zamiennik za zgubiona). Kolejnosc na ekranie jest
  // tu podpowiedzia, ktora kosztuje pieniadze, gdy stoi odwrotnie.
  const metoda = String(metodaWysylki(z) ?? '');
  const wza = Object.hasOwn(WZA_DO_WYBORU, metoda) ? WZA_DO_WYBORU[metoda] : undefined;
  if (czyPobranie(z) && pobranieNaTejPaczce) {
    // ⚠️ POBRANIE PRZEZ WzA WESZLO 11.08.2026 — i wlasnie tu bylo do odblokowania.
    // Ograniczenie do samego DPD chronilo przed PACZKOMATEM bez inkasa (umowa z InPostem na
    // pobranie NIEPOTWIERDZONA), a nie przed Allegro: tam inkaso jest czescia uslugi
    // (`13f26351-…`, limit 6000 zl, `paymentType: WALLET_TRANSFER` — zmierzone). Wyliczamy
    // wiec, co WOLNO, zamiast odsiewac wszystko poza DPD.
    // PRZ-135.04a: „DPD" = kurierzy z `pobranie: 'umowa'` w rejestrze (dzis tylko DPD; InPost
    // ma 'adapter', czyli umie kwote, ale umowy na inkaso nie ma — patrz komentarz nad funkcja).
    // PRZ-135.T2: umowa firmy na pobranie (np. InPost) awansuje kuriera z 'adapter'.
    // PRZ-137.03 (D2): zamiennik (paczka 2+ z pobraniem) — tylko kurierzy, ktorych adapter
    // wiezie pobranie na kolejnej paczce (`pobranieNaDosylce`: DPD, InPost z umowa firmy);
    // WzA bierze pobranie z zamowienia Allegro, wiec przy zamienniku znika z listy.
    const dosylka = kolejnosc > 1;
    const naUmowie = DO_WYBORU.filter((k) => (!dosylka || pobranieNaDosylce(k.klucz, rejestr))
      && pobranieNaUmowie(k.klucz, rejestr, umowyPobrania));
    const wolnoPrzyPobraniu = wza && (!dosylka || pobranieNaDosylce(metoda, rejestr)) ? [wza, ...naUmowie] : naUmowie;
    return wolnoPrzyPobraniu;
  }
  return wza ? [wza, ...DO_WYBORU] : DO_WYBORU;
}

/**
 * Metoda, ktora NAPRAWDE obsluzy to nadanie: `{ metoda }` albo `{ blad }`.
 *
 * Dla zamowien spoza Allegro oddaje metode zamowienia, a `wybor` IGNORUJE CALKOWICIE —
 * i to jest najwazniejsza linia w tym pliku. Gdyby wybor dzialal wszedzie, spreparowane
 * (albo pomylkowe) `kurier=inpost_paczkomat` zamienialoby sklepowe zamowienie za pobraniem
 * w przesylke paczkomatowa bez inkasa, omijajac cala tablice dostaw
 * (domain/mapowanie-wysylki.js), ktora istnieje dokladnie po to, zeby tego pilnowac.
 *
 * ⚠️ ODMOWA JEST TU, W DOMENIE, A NIE W WIDOKU. Ekran nadania nie pokaze formularza bez
 * wskazanego kuriera, ale ekran nie jest bariera — bariera musi przezyc zadanie POST
 * zlozone z reki albo ze starej, otwartej karty.
 */
// PRZ-135.T2: `umowyPobrania` = `umowyPobraniaFirmy(db)` (moduly/wysylka/db/umowy-pobrania.js);
// pominiete daje `[]`, czyli surowiej, nigdy luzniej.
export function metodaNadania(z, wybor, { kolejnosc = 1, umowyPobrania = /** @type {readonly string[]} */ ([]) } = {}) {
  const metoda = metodaWysylki(z);
  // ⚠️ METODA, KTORA PANEL NADAJE SAM MIMO ALLEGROWEGO KANALU (dzis: paczkomat). Wskazanie
  // jest tu IGNOROWANE tak samo, jak przy zamowieniach sklepowych — inaczej wracalaby furtka
  // ta sama dziura, przed ktora broni ten sam warunek pietro nizej: jedno pole formularza
  // przestawialoby przesylke na innego kuriera, omijajac cala tablice dostaw.
  if (Object.hasOwn(NADAJEMY_SAMI, String(metoda ?? ''))) {
    return { metoda: NADAJEMY_SAMI[metoda] };
  }
  if (!wymagaWyboruKuriera(z)) return { metoda };

  const wskazany = String(wybor ?? '').trim();
  const dozwolone = kurierzyDoWyboru(z, kolejnosc, { umowyPobrania });
  if (!wskazany) {
    // Brak wskazania = droga domyślna, czyli „Wysyłam z Allegro" — tam, gdzie ją mamy.
    if (Object.hasOwn(WZA_DOMYSLNIE, String(metoda ?? ''))) return { metoda: WZA_DOMYSLNIE[metoda] };
    return {
      blad: 'To zamówienie przyszło z Allegro, więc panel nie zna kuriera, którym mamy je nadać — '
        + 'paczkę z Allegro nadaje się etykietą kupioną w panelu Allegro. Jeśli chcesz nadać ją '
        + 'NASZĄ umową (dosyłka, zamiennik za zgubioną), wskaż kuriera na ekranie nadania.',
    };
  }

  // ⚠️ `wza` NIE JEST KURIEREM, tylko nazwa DROGI DOMYSLNEJ na ekranie wyboru. Zamieniamy ja
  // na metode zamowienia, czyli dokladnie na to, co dzieje sie przy BRAKU wskazania — zeby
  // klikniecie „Wysyłam z Allegro" i puste pole znaczyly to samo, a nie dwie rozne sciezki.
  if (wskazany === 'wza' && Object.hasOwn(WZA_DOMYSLNIE, String(metoda ?? ''))) {
    return { metoda: WZA_DOMYSLNIE[metoda] };
  }

  if (!dozwolone.some((k) => k.klucz === wskazany)) {
    return {
      blad: `Nie umiem nadać tej paczki jako „${wskazany}" — do wyboru jest `
        + `${dozwolone.map((k) => k.etykieta).join(' albo ')}. Panel niczego nie nadał.`,
    };
  }
  return { metoda: wskazany, wskazanyRecznie: true, metodaZamowienia: metoda };
}

/**
 * Czy z TEGO nadania powstanie etykieta ZPL — czyli czy „Nadaj i drukuj" ma co wstawić do
 * kolejki druku na Zebrze.
 *
 * WzA pozwala wybrac `labelFormat` przy tworzeniu przesylki. „Nadaj i drukuj" zamawia
 * ZPL, a zwykle „Nadaj" PDF; pozniej formatu nie mozna zmienic. Paczkomat Allegro jedzie
 * NASZA umowa InPost i trafia tutaj jako `inpost_paczkomat`, nie `allegro_paczkomat`.
 *
 * 01.09.2026 przycisk ukryto dla WzA, bo adapter zamawial tylko PDF i wydruk nie dzialal.
 * Od 21.09.2026 wraca dla metod z WZA_DOMYSLNIE, bo sam wybor przycisku zamawia ZPL.
 *
 * ⚠️ BIALA LISTA, nie „wszystko oprocz Allegro" — dokladnie jak STANY_KONCOWE_WERYFIKACJI
 * w allegro-faktura.js i z tego samego powodu: kurier dolozony jutro nie ma prawa odziedziczyc
 * obietnicy wydruku tylko dlatego, ze nie nazywa sie „allegro".
 */
// PRZ-135.04a: z rejestru — metody kurierow z `etykieta.zpl` (dzis DPD, paczkomat, 4 metody WzA).
export const METODY_Z_ZPL = [...metodyZZpl()];

export function nadanieDaZpl(metodaUzyta) {
  return METODY_Z_ZPL.includes(String(metodaUzyta ?? ''));
}
