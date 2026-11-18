import { metodaWysylki, czyPobranie, metodaZeSklepu, pobranieZeSklepu } from './wysylka.js';
import {
  MODULY_KURIEROW,
  kurierDlaMetody,
  metodyNaUmowie,
  metodyZZpl,
  pobranieNaUmowie,
  pobranieNaDosylce,
} from './moduly-kurierow.ts';
import { czyKanalWbudowany } from './kanaly.js';

/**
 * „Pobranie ze sklepu" — sklep SPRZEDAŁ tę dostawę za
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
 * Czy nadanie TĄ metodą wymaga włączonej umowy firmy na pobranie. `true`
 * WYŁĄCZNIE dla pobrania OMS-owego (ręczne, zmienione na karcie) u kuriera z pobraniem
 * 'adapter' w rejestrze, gdy firma nie zaznaczyła umowy. Kurier 'umowa' (DPD, WzA) — nigdy;
 * 'brak' odmawia gdzie indziej.
 * `zamiennik` — pobranie na paczce N > 1 to ZAWSZE pobranie OMS-owe (decyzja
 * operatora, nie sklepu), więc „pobranie ze sklepu" go nie zwalnia z umowy.
 */
export function wymagaUmowyPobrania(
  z,
  metoda,
  rejestr = MODULY_KURIEROW,
  umowy = /** @type {readonly string[]} */ ([]),
  { zamiennik = false } = {},
) {
  if (!czyPobranie(z) || (!zamiennik && pobranieSklepowe(z))) return false;
  const kurier = kurierDlaMetody(metoda, rejestr);
  if (kurier === null || rejestr[kurier]?.umiejetnosci?.pobranie !== 'adapter') return false;
  return !pobranieNaUmowie(metoda, rejestr, umowy);
}

/**
 * Powód odmowy, gdy `wymagaUmowyPobrania` daje `true` — JEDEN tekst dla hurtu
 * (domena/masowe.js) i karty (moduly/wysylka/services/nadanie.js, ostrzeżenie
 * w moduly/wysylka/widoki/nadaj.ejs). Nazwa kuriera z rejestru,
 * bez założenia, że zostaje DPD. Mała litera na początku (hurt wstawia go jako powód pominięcia).
 */
export function powodUmowyPobrania(metoda, rejestr = MODULY_KURIEROW) {
  const kurier = kurierDlaMetody(metoda, rejestr);
  const nazwa = (kurier !== null && rejestr[kurier]?.nazwa) || 'tego kuriera';
  return `pobranie przez ${nazwa} wymaga umowy — włącz ją w Ustawieniach → Integracje albo zmień kuriera na karcie zamówienia`;
}

/**
 * Powód odmowy zamiennika za pobraniem (paczka N > 1, zaznaczone pobranie
 * na tej paczce) tą metodą albo `null`, gdy wolno. Kurier bez `pobranieNaDosylce` → tekst
 * neutralny (bez założenia, który kurier zostaje); kurier 'adapter' bez umowy firmy → ten sam
 * powód co przy paczce nr 1. Mała litera na początku, jak `powodUmowyPobrania`.
 */
export function powodOdmowyZamiennika(
  z,
  metoda,
  { rejestr = MODULY_KURIEROW, umowyPobrania = /** @type {readonly string[]} */ ([]) } = {},
) {
  if (!czyPobranie(z)) return null;
  if (!pobranieNaDosylce(metoda, rejestr)) {
    const kurier = kurierDlaMetody(metoda, rejestr);
    const nazwa = (kurier !== null && rejestr[kurier]?.nazwa) || 'ten kurier';
    return `${nazwa} nie przyjmie pobrania na kolejnej paczce — wybierz kuriera, który je przyjmuje, albo wyłącz pobranie na tej paczce`;
  }
  if (wymagaUmowyPobrania(z, metoda, rejestr, umowyPobrania, { zamiennik: true }))
    return powodUmowyPobrania(metoda, rejestr);
  return null;
}

// Kurier, którym NADAJEMY tę konkretną paczkę — a nie metoda, którą klient wybrał, kupując.
//
// ⚠️ ISTNIEJE DLA JEDNEGO PRZYPADKU I WARTO GO ZNAĆ: zamówienie przyszło z Allegro, pierwsza
// paczka pojechała etykietą kupioną w panelu Allegro, a teraz trzeba dosłać brakujący produkt
// WŁASNYM kurierem. Bez tego modułu panel pokazałby przycisk „Nadaj paczkę” i komplet pól,
// a zatwierdzenie odbiłoby się o „metoda nieobsługiwana” — już PO zapakowaniu paczki.
//
// ⚠️ BARIERA, KTÓRA TO ODBIJA, NIE JEST PRZEOCZENIEM I NIE WOLNO JEJ ZDJĄĆ. Chroni przed
// nadaniem DRUGIEJ, PŁATNEJ paczki do klienta, który swoją już dostał — a token Allegro ma
// prawo nadawania, więc po tamtej stronie nie chroni nas NIC. Ten moduł bariery nie usuwa:
// zamienia ją z „nie da się nigdy” na „da się WYŁĄCZNIE po świadomym wskazaniu człowieka”.
//
// ⚠️⚠️ GDZIE TA BARIERA STOI. Nie na zgrubnej KATEGORII metody: `allegro_punkt`,
// `allegro_kurier` i `allegro_inne` prowadzą do adaptera WzA, a prawdziwa odmowa siedzi
// w `wolnoNadacZOms` (domena/allegro-wysylka.js) i pyta o KONKRETNY identyfikator usługi
// z ŻYWEGO odczytu zamówienia. Kategorię zgadujemy my, identyfikator przychodzi z Allegro.
// ⛔ `allegro_paczkomat` nie ma kuriera w rejestrze (`kurierDlaMetody` w
// domena/moduly-kurierow.ts daje null), bo usługi InPostu mają `owner: CLIENT`, czyli NASZĄ umowę.
//
// ⚠️ DLACZEGO NIE „PRZESTAW METODĘ NA KARCIE Z allegro_dpd NA dpd”. Ta droga działa
// i właśnie dlatego jest zła: `wysylka_reczna_json` to nadpisanie TRWAŁE, więc zamówienie
// na zawsze kłamałoby, że klient wybrał nasze DPD; przestałoby też być rozpoznawalne po
// metodzie w nadaniu zbiorczym (domena/masowe.js pilnuje OBU siatek — kanału i metody —
// właśnie z tego powodu). Wybór z ekranu nadania jest JEDNORAZOWY: dotyczy tej paczki,
// niczego nie zapisuje do zamówienia. Ta sama rodzina co kod paczkomatu i kwota pobrania.

/**
 * Metody, które panel umie nadać SAM (NASZA umowa) — z rejestru kurierów: metody kurierów
 * z `umowa: 'wlasna'` w kolejności rejestru (dziś DPD, paczkomat InPost), z etykietą
 * wyboru (`etykietaWyboru`, zapasowo `etykieta`). Podzbiór metod z kurierem z definicji.
 */
const doWyboru = (rejestr) =>
  metodyNaUmowie('wlasna', rejestr).map((m) => ({ klucz: m.klucz, etykieta: m.etykietaWyboru ?? m.etykieta }));

/**
 * Czy to zamówienie wymaga, żeby człowiek WSKAZAŁ kuriera, zanim panel cokolwiek nada.
 *
 * ⚠️ Liczone po METODZIE, a nie po kanale (`czyKanalAllegro`) — i tu, wyjątkowo, tak ma być.
 * Kanał odpowiada na pytanie „czyja to sprzedaż” i tym pilnuje się odmów (domena/masowe.js,
 * sync-sklep.js). Tutaj pytanie brzmi „czy panel wie, czym to wysłać”, a na nie odpowiada
 * wyłącznie metoda: `allegro_paczkomat` nie ma kuriera w rejestrze (`kurierDlaMetody`)
 * niezależnie od tego, z którego konta przyszło. Kierunek jest przy tym bezpieczny: metoda
 * przestawiona ręcznie na `dpd` wychodzi z tego warunku, ale wpada w ten sam `wybierzKuriera`
 * (oms/kurierzy/index.js) co zawsze.
 */
// ⚠️⚠️ PACZKOMAT Z ALLEGRO NADAJEMY MY, I TO NIE JEST WYJĄTEK OD BARIERY, TYLKO JEJ
// WŁAŚCIWY ZAKRES: paczki paczkomatowej z Allegro nie da się nadać przez Allegro.
//
// Bariera istnieje po to, żeby panel nie nadał DRUGIEJ, PŁATNEJ paczki do klienta, który
// swoją już dostał — a ryzyko drugiej paczki bierze się STĄD, ŻE ALLEGRO POTRAFI SPRZEDAĆ
// ETYKIETĘ na tę samą przesyłkę. Przy paczkomacie Allegro etykiety NIE SPRZEDAJE, więc
// pierwszej paczki z tamtej strony po prostu nie ma i nie ma czego dublować. Pytanie
// o kuriera przy KAŻDEJ metodzie allegrowej byłoby za szerokie: dokładałoby kliknięcie
// do ścieżki, w której nie ma żadnej niejednoznaczności.
//
// ⚠️ POZOSTAŁE METODY ALLEGROWE ZOSTAJĄ PRZY BARIERZE — czyli przechodzą przez pytanie
// o kuriera, zamiast być nadawane automatycznie naszą umową.
//
// ⚠️⚠️ NIE DLATEGO, ŻE „panel nie umie ich nadać”. `allegro_punkt`, `allegro_kurier`
// i `allegro_inne` mają drogę domyślną („Wysyłam z Allegro”) i usługi w `METODY_WZA`
// (domena/allegro-wysylka.js). Przy barierze zostają dlatego, że wskazanie człowieka ma
// dalej rządzić — to jest furtka na DOSYŁKĘ naszą umową (zamiennik za zgubioną), którą
// `NADAJEMY_SAMI` by odebrało.
// Ta mapa zostaje JAWNA (reguła pieniędzy, nie dane kuriera). Cel musi być metodą
// kuriera na NASZEJ umowie z rejestru — inaczej panel nie wystartuje, zamiast cicho odmawiać.
const NADAJEMY_SAMI = { allegro_paczkomat: 'inpost_paczkomat' };
for (const [metoda, cel] of Object.entries(NADAJEMY_SAMI)) {
  if (!metodyNaUmowie('wlasna').some((m) => m.klucz === cel)) {
    throw new Error(
      `NADAJEMY_SAMI: ${metoda} → ${cel}, a ${cel} nie jest metodą kuriera na własnej umowie w rejestrze`,
    );
  }
}

// ⚠️⚠️ METODY WzA NIE WYMAGAJĄ WSKAZANIA KURIERA — BRAK WSKAZANIA TO „Wysyłam z Allegro”.
//
// Etykietę z Allegro KUPUJE PANEL (oms/kurierzy/allegro-wza.js), na umowie Allegro i tą samą
// usługą, którą wybrał kupujący. Ryzyko, przed którym stoi bariera, nie znika — przenosi się:
// druga paczka grozi nie z pomyłki kuriera, tylko z etykiety kupionej RĘCZNIE w panelu
// Allegro. Broni przed tym osobne sprawdzenie w adapterze (`GET .../shipments` przed zakupem).
//
// ⚠️ TO NIE JEST WPIS DO `NADAJEMY_SAMI` — i ta różnica jest cała. `NADAJEMY_SAMI` IGNORUJE
// wskazanie człowieka, więc wpisanie tam `allegro_dpd` zabrałoby furtkę na DOSYŁKĘ naszą
// umową („zamiennik za zgubioną”), którą komunikat niżej wprost obiecuje. Tutaj wskazanie
// dalej rządzi — ta mapa mówi WYŁĄCZNIE, co się dzieje przy jego BRAKU: „Wysyłam z Allegro”
// zamiast odmowy.
// ⚠️⚠️ `allegro_inne` TEŻ TU JEST, razem z `allegro_punkt` i `allegro_kurier`.
//
// `allegro_inne` to WOREK na wszystko, czego słownik nie umie nazwać — i wpuszczenie go tutaj
// wygląda na rozszczelnienie bariery. Nie jest, bo BARIERA NIE STOI W TEJ MAPIE.
// Ta mapa odpowiada tylko na pytanie „która droga jest domyślna dla tej KATEGORII metody”;
// prawdziwa odmowa siedzi w `wolnoNadacZOms` i pyta o KONKRETNY identyfikator usługi
// z ŻYWEGO odczytu zamówienia. Nieznana usługa Allegro odbije się więc tam — głośno
// i po identyfikatorze, a nie po zgrubnej kategorii, którą Allegro może przypisać inaczej.
//
// ⛔ `allegro_paczkomat` CELOWO TU NIE MA — siedzi w `NADAJEMY_SAMI` i ma tam zostać.
// Usługi InPostu mają w katalogu Allegro `owner: CLIENT`, czyli NASZĄ umowę: nadanie ich
// „przez Allegro” byłoby drugim, płatnym przewozem do klienta, który swój ma już opłacony.
//
// Lista = metody kuriera z `umowa: 'platformy'` w rejestrze (dziś WzA: allegro_dpd,
// allegro_punkt, allegro_kurier, allegro_inne). Usunięcie metody tam = odmowa jej nadania tu.
const wzaDomyslnie = (rejestr) =>
  Object.fromEntries(metodyNaUmowie('platformy', rejestr).map((m) => [m.klucz, m.klucz]));
const WZA_DOMYSLNIE = wzaDomyslnie(MODULY_KURIEROW);

export function wymagaWyboruKuriera(z) {
  const metoda = String(metodaWysylki(z) ?? '');
  if (!metoda.startsWith('allegro_')) return false;
  return !Object.hasOwn(NADAJEMY_SAMI, metoda);
}

/**
 * Kurierzy, których wolno wskazać dla TEJ paczki tego zamówienia.
 *
 * ⚠️ PRZY POBRANIU NA PACZCE NR 1 ZOSTAJĄ SAMI KURIERZY Z UMOWĄ NA POBRANIE (oraz WzA, gdy jest drogą
 * domyślną tej metody — tam inkaso jest częścią usługi Allegro) — i to jest ochrona pieniędzy, nie ostrożność. Pobranie paczkomatowe jest w panelu ZBUDOWANE, ale to, czy firma
 * ma z InPostem UMOWĘ NA INKASO, nie wynika z konta (przesyłki bez `cod`, lista usług bez
 * wariantu pobraniowego). Wskazanie paczkomatu dla zamówienia za pobraniem bez takiej umowy
 * mogłoby więc dać przesyłkę, przy której InPost nie zainkasuje NIC — czyli towar oddany
 * za darmo, bez ani jednego błędu po drodze.
 *
 * Na paczce N > 1 pobranie DOMYŚLNIE nie jedzie, więc tam wybór jest pełny — i właśnie
 * dlatego warunek nie pyta o samo `czyPobranie`: dosyłka do zamówienia pobraniowego to
 * najzwyklejszy przypadek użycia tego ekranu.
 *
 * ⚠️⚠️ ALE „N > 1” NIE ZNACZY „bez pobrania”. Operator może kazać pobraniu pojechać
 * na paczce N > 1, gdy jest ona ZAMIENNIKIEM pierwszej (wyrzucona etykieta — uzasadnienie
 * przy warunku <cod> w oms/kurierzy/dpd.js). Dyskryminatorem jest więc „czy pobranie
 * jedzie na TEJ paczce”, a NIE jej numer. Gdyby został numer, powstałaby droga: zamiennik za
 * pobraniem przez paczkomat → InPost nie inkasuje NIC → towar oddany za darmo, bez ani
 * jednego błędu po drodze. To jest ta sama ochrona pieniędzy, co przy paczce nr 1, tylko
 * kluczowana faktem zamiast numeru.
 */
// ⚠️⚠️ DROGA DOMYŚLNA MUSI BYĆ NA LIŚCIE WYBORU.
//
// `WZA_DOMYSLNIE` sprawia, że BRAK wskazania prowadzi do „Wysyłam z Allegro” — ale ekran
// nadania każe wybrać pozycję Z LISTY. Gdyby lista znała wyłącznie naszych kurierów,
// jedyne, co dałoby się kliknąć, to nadanie NASZĄ umową, czyli drugi płatny przewóz do
// klienta, który ma już opłaconą dostawę. Reguła bez wpisu w tej liście jest niedostępna —
// i to jest ta sama lekcja, co „ekran nie jest barierą”: ekran nie jest też DROGĄ.
// ⚠️ KAŻDA metoda z `WZA_DOMYSLNIE` MUSI mieć tu wpis — inaczej droga domyślna jest
// NIEDOSTĘPNA z ekranu i jedyne, co da się kliknąć, to nadanie naszą umową, czyli drugi
// płatny przewóz (akapit wyżej). Test-strażnik pilnuje, że obie mapy mają te same klucze.
const ETYKIETA_WZA = 'Wysyłam z Allegro — umowa Allegro (domyślnie)';
const wzaDoWyboru = (rejestr) =>
  Object.fromEntries(
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

export function kurierzyDoWyboru(
  z,
  kolejnosc = 1,
  {
    pobranieNaTejPaczce = kolejnosc === 1,
    rejestr = MODULY_KURIEROW,
    umowyPobrania = /** @type {readonly string[]} */ ([]),
  } = {},
) {
  const { doWyboru: DO_WYBORU, wzaDoWyboru: WZA_DO_WYBORU } = regulyNadania(rejestr);
  // ⚠️ WzA IDZIE PIERWSZE i tak ma zostac: przy zamowieniu z Allegro to jest droga wlasciwa,
  // a nasza umowa jest wyjatkiem (dosylka, zamiennik za zgubiona). Kolejnosc na ekranie jest
  // tu podpowiedzia, ktora kosztuje pieniadze, gdy stoi odwrotnie.
  const metoda = String(metodaWysylki(z) ?? '');
  const wza = Object.hasOwn(WZA_DO_WYBORU, metoda) ? WZA_DO_WYBORU[metoda] : undefined;
  if (czyPobranie(z) && pobranieNaTejPaczce) {
    // ⚠️ POBRANIE PRZEZ WzA JEST DOZWOLONE — ograniczenie chroni przed PACZKOMATEM bez inkasa
    // (bez umowy firmy na pobranie z InPostem), a nie przed Allegro: tam inkaso jest
    // częścią usługi (`paymentType: WALLET_TRANSFER`). Wyliczamy więc, co WOLNO, zamiast
    // odsiewać wszystko poza jednym kurierem.
    // Wolno = kurierzy z `pobranie: 'umowa'` w rejestrze. InPost ma 'adapter': umie kwotę,
    // ale wchodzi na listę dopiero z umową firmy na pobranie (`umowyPobrania`).
    // Zamiennik (paczka 2+ z pobraniem) — tylko kurierzy, których adapter
    // wiezie pobranie na kolejnej paczce (`pobranieNaDosylce`: DPD, InPost z umową firmy);
    // WzA bierze pobranie z zamówienia Allegro, więc przy zamienniku znika z listy.
    const dosylka = kolejnosc > 1;
    const naUmowie = DO_WYBORU.filter(
      (k) => (!dosylka || pobranieNaDosylce(k.klucz, rejestr)) && pobranieNaUmowie(k.klucz, rejestr, umowyPobrania),
    );
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
 * (domena/mapowanie-wysylki.js), ktora istnieje dokladnie po to, zeby tego pilnowac.
 *
 * ⚠️ ODMOWA JEST TU, W DOMENIE, A NIE W WIDOKU. Ekran nadania nie pokaze formularza bez
 * wskazanego kuriera, ale ekran nie jest bariera — bariera musi przezyc zadanie POST
 * zlozone z reki albo ze starej, otwartej karty.
 */
// `umowyPobrania` = `umowyPobraniaFirmy(db)` (moduly/wysylka/db/umowy-pobrania.js);
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
      blad:
        'To zamówienie przyszło z Allegro, więc panel nie zna kuriera, którym mamy je nadać — ' +
        'paczkę z Allegro nadaje się etykietą kupioną w panelu Allegro. Jeśli chcesz nadać ją ' +
        'NASZĄ umową (dosyłka, zamiennik za zgubioną), wskaż kuriera na ekranie nadania.',
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
      blad:
        `Nie umiem nadać tej paczki jako „${wskazany}" — do wyboru jest ` +
        `${dozwolone.map((k) => k.etykieta).join(' albo ')}. Panel niczego nie nadał.`,
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
 * Dla metod z WZA_DOMYSLNIE przycisk jest, bo sam wybór przycisku zamawia ZPL; adapter
 * zamawiający tylko PDF dałby przycisk, który niczego nie drukuje.
 *
 * ⚠️ BIALA LISTA, nie „wszystko oprocz Allegro" — dokladnie jak STANY_KONCOWE_WERYFIKACJI
 * w allegro-faktura.js i z tego samego powodu: kurier dolozony jutro nie ma prawa odziedziczyc
 * obietnicy wydruku tylko dlatego, ze nie nazywa sie „allegro".
 */
// Z rejestru — metody kurierow z `etykieta.zpl` (dzis DPD, paczkomat, 4 metody WzA).
export const METODY_Z_ZPL = [...metodyZZpl()];

export function nadanieDaZpl(metodaUzyta) {
  return METODY_Z_ZPL.includes(String(metodaUzyta ?? ''));
}
