import { etapPrzesylki, bezRuchu } from './etap-przesylki.js';

// Stan przesylki CZYTANY z wiersza. Dokladny odpowiednik faktura-stan.js — i powstal
// dlatego, ze po stronie nadania nie bylo NICZEGO z tego, co Zadanie 11 dorobilo dla faktur:
// ani progu, ani stanu „zawieszona", ani akcji operatora, ani straznika, ani komunikatu.
//
// Wiersz 'w_trakcie' powstaje PRZED wywolaniem kuriera i normalnie zyje sekundy. Jesli proces
// panelu padnie dokladnie w trakcie `klient.nadaj` (restart, deploy, reboot NAS-a), wiersz
// zostaje na zawsze: karta dalej pokazuje przycisk „Nadaj paczke", kazde klikniecie odbija sie
// od indeksu czesciowego komunikatem „Nadanie wlasnie trwa", a jedynym wyjsciem jest reczny
// UPDATE w pliku SQLite. Po tym progu przestajemy udawac, ze cos trwa.
//
// UWAGA — TO NIE JEST TEN SAM PROBLEM CO PRZY FAKTURZE, MIMO IDENTYCZNEGO KSZTALTU:
// naiwne „odblokuj i ponow" byloby tu BLEDNE. DPD moglo juz przydzielic numer listu, a wtedy
// ponowienie z ta sama referencja i tak wroci z DUPLICATED_PARCEL_SEARCH_KEY (zweryfikowane
// na zywym API w Zadaniu 10), a paczka u kuriera fizycznie istnieje. Dlatego panel po progu
// mowi „wisi, sprawdz w panelu DPD", a decyduje czlowiek — dokladnie jak przy fakturze w KSeF.
//
// Prog z zapasem: nadanie to DWA zadania SOAP (V10 + V4), kazde z twardym limitem
// LIMIT_NADANIA_MS. Straznik przy wczytaniu kurierzy/dpd.js pilnuje, zeby ich suma byla
// KROTSZA od tego progu — inaczej „zawieszona" moglaby oznaczac zywe wywolanie.
export const PROG_ZAWIESZONEGO_NADANIA_MS = 5 * 60 * 1000;

// 'brak' — nie ma przesylki, wolno nadawac.
// 'w_trakcie' — wywolanie DPD naprawde trwa; czekamy.
// 'tworzona_u_kuriera' — przesylka U KURIERA JUZ ISTNIEJE (mamy jej identyfikator), ale
//                        numeru listu jeszcze nie dostala. Wyjscie: „Sprawdz ponownie".
// 'zawieszona' — wiersz osierocony (restart procesu w trakcie wywolania).
// 'do_wyjasnienia' — DPD przydzielilo numer listu, ale nadanie nie doszlo do konca.
// 'nadana' — jest numer listu, paczka istnieje.
// 'blad' — nadanie padlo PRZED przydzieleniem numeru; miejsce zwolnione pod ponowienie.
export function stanPrzesylki(p, teraz = Date.now()) {
  if (!p) return 'brak';
  if (p.status !== 'w_trakcie') return p.status;
  // ⚠️ IDENTYFIKATOR U KURIERA BIJE PROG ZAWIESZENIA (Zadanie 6, InPost). Tworzenie
  // przesylki w ShipX bywa asynchroniczne: `POST` konczy sie sukcesem, przesylka ISTNIEJE,
  // a numeru listu jeszcze nie ma. Taki wiersz zostaje 'w_trakcie' z zapisanym
  // `id_przesylki_kuriera` — i nie wolno go po piatej minucie nazwac „zawieszonym".
  //
  // „Zawieszona" znaczy „NIE WIADOMO, czy paczka u kuriera powstala — zajrzyj do panelu
  // i rozstrzygnij", a jej wyjscie (odblokujPrzesylke bez numeru listu) przestawia wiersz
  // na 'blad', czyli ZWALNIA miejsce w indeksie czesciowym. Tutaj wiemy na pewno, ze
  // przesylka istnieje, wiec to samo wyjscie oznaczaloby DRUGA prawdziwa paczke —
  // a InPost, w odroznieniu od DPD, nie odsieje jej po referencji (spec, 4.4).
  if (p.id_przesylki_kuriera && !p.numer_listu) return 'tworzona_u_kuriera';
  const start = Date.parse(p.utworzona_at ?? '');
  // Nieczytelna data NIE jest dowodem, ze wywolanie trwa. Uznanie jej za „trwa" dawaloby
  // dokladnie te wieczna blokade, ktorej ten stan ma zapobiegac — a wyjscie i tak wymaga
  // czlowieka, ktory najpierw zajrzy do panelu DPD.
  if (!Number.isFinite(start)) return 'zawieszona';
  return teraz - start >= PROG_ZAWIESZONEGO_NADANIA_MS ? 'zawieszona' : 'w_trakcie';
}

// ---------------------------------------------------------------------------------
// ZRODLO NUMERU LISTU (kolumna `przesylki.zrodlo_numeru`, recenzja calej galezi 04.08.2026)
//
// ⚠️ TO NIE JEST TO SAMO CO `kurier` I WLASNIE NA TYM POLEGALA USTERKA I-1.
// `kurierWpisuRecznego('allegro_*')` oddaje `'allegro'` TAKZE dla wiersza, ktory czlowiek
// wpisal z reki na karcie zamowienia z Allegro — bo kurier ma tam sterowac linkiem do
// sledzenia i tym, kogo (nie) pytac o status, a nie tym, skad wzial sie numer. Odmowa
// kasowania kluczowana `kurier === 'allegro'` obejmowala wiec RECZNY WPIS i uzasadniala to
// zdaniem „numer panel PRZECZYTAL z konta Allegro, wiec literowka jest niemozliwa" —
// dla wpisu z reki NIEPRAWDA. Skutek byl trwaly: zly numer zostawal na zawsze (prawdziwy
// sie nie dociagnie, bo dociaganie wymaga pustego `wyslane_at`, a rejestracja reczna je
// USTAWIA), a jedynym wyjsciem byl DELETE w pliku bazy — niezmiennik 4.9 wprost.
//
// Dyskryminatorem jest wiec ZRODLO NUMERU, a nie kurier:
//   'reka'    — numer PRZEPISAL CZLOWIEK (rejestracja przesylki nadanej poza panelem).
//               Literowka jest tu mozliwa, wiec kasowanie MUSI byc dozwolone.
//   'allegro' — numer PRZECZYTAL PANEL z konta Allegro (services/przesylki-allegro.js).
//               Literowki nie ma, a skasowany wiersz nie wroci — kasowanie zostaje zabronione.
//
// NULL czytamy jako 'reka' i to jest jedyny bezpieczny domysl: wiersze sprzed tej kolumny
// powstaly WYLACZNIE z rejestracji recznej (kanalu Allegro jeszcze nie bylo), a migracja
// w db/db.js i tak oznacza ewentualne wiersze z kurierem 'allegro' jawnie.
export const ZRODLO_NUMERU = { REKA: 'reka', ALLEGRO: 'allegro' };

export const zrodloNumeru = (p) => p?.zrodlo_numeru ?? ZRODLO_NUMERU.REKA;

/** Numer PRZECZYTANY z konta Allegro — kasowaniu NIE podlega. */
export const numerZAllegro = (p) => zrodloNumeru(p) === ZRODLO_NUMERU.ALLEGRO;

/**
 * Numer PRZEPISANY Z REKI — czyli dokladnie ten, w ktorym moze byc literowka.
 *
 * Steruje i odmowa w bazie (skasujPrzesylkeReczna), i widocznoscia przycisku na karcie:
 * przycisk ma stac dokladnie tam, gdzie kasowanie jest dozwolone. Rozjazd tych dwoch znaczy
 * albo przycisk prowadzacy prosto w odmowe, albo — jak przed ta poprawka — wyjscie, ktore
 * istnieje w kodzie, ale ktorego nikt nie widzi.
 */
export const numerWpisanyZReki = (p) => Boolean(p?.nadana_recznie) && !numerZAllegro(p);

/**
 * CZY PACZKA JEST UKRYTA Z ZAKLADKI /przesylki (25.08.2026).
 *
 * Ukrycie jest dla paczek, ktorych zaden status nie uratuje: zamowienie testowe, etykieta
 * zrobiona i nigdy przez kuriera niepodjeta. Zdejmuje wiersz z listy ORAZ sprawe „paczka
 * bez ruchu" z karty — oba naraz, bo rozjazd tych dwoch zostawialby zamowienie na liscie
 * roboczej z odznaka, ktorej nic nie zdejmuje.
 *
 * ⚠️⚠️ NOWE ZDARZENIE KURIERA KASUJE UKRYCIE. Ukryta paczka, ktora po tygodniu jednak
 * ruszyla — albo wrocila jako zwrot — MA WROCIC NA OCZY: to nowina, a nie stan, o ktorym
 * czlowiek juz zdecydowal. Bez tego warunku „Ukryj" bylby cichym „nie chce wiedziec"
 * i zabieral paczke z pola widzenia dokladnie wtedy, gdy zaczyna wymagac czlowieka.
 *
 * Rownosc chwil NIE przywraca: zdarzenie o tym samym znaczniku co ukrycie to dokladnie ten
 * stan, ktory czlowiek widzial, klikajac „Ukryj".
 */
/**
 * Czy przy TEJ paczce wolno pokazac na karcie przycisk „Ukryj".
 *
 * Zgloszenie wlasciciela 04.09.2026, po zamowieniu 1385: po nadaniu ZAMIENNIKA pierwsza
 * paczka zostaje na karcie jako „nadana" i tak juz zostanie — kurier nigdy jej nie
 * zeskanuje, bo etykieta poszla do kosza. Zaden status jej nie uratuje, a lista robocza
 * dopomina sie o nia w nieskonczonosc.
 *
 * ⚠️ TO JEST OPCJA, NIGDY AUTOMAT, i to nie jest ostroznosc na wyrost: panel NIE WIE, czy
 * paczka nr 1 umarla (zamiennik), czy jedzie obok (zwykla dosylka — najzwyklejszy przypadek
 * dwoch paczek). Automatyczne ukrywanie zdejmowaloby z oczu prawdziwe, jadace przesylki
 * przy kazdej dosylce. Wie to wylacznie czlowiek, wiec decyduje klikniecie.
 *
 * ⚠️ Wiersz 'blad' NIE jest „kolejna paczka" — nieudane nadanie zwalnia miejsce w indeksie
 * czesciowym i zadna przesylka po nim nie powstala. Liczenie go otwieraloby „Ukryj" przy
 * JEDYNEJ prawdziwej paczce zamowienia.
 */
export function mozliweUkrycie(p, przesylki) {
  if (!p || przesylkaUkryta(p)) return false;
  return (przesylki ?? []).some((inna) => inna.status !== 'blad' && inna.kolejnosc > p.kolejnosc);
}

export function przesylkaUkryta(p) {
  const ukryta = Date.parse(p?.ukryta_at ?? '');
  if (!Number.isFinite(ukryta)) return false;
  const zdarzenie = Date.parse(p?.status_kuriera_at ?? '');
  if (Number.isFinite(zdarzenie) && zdarzenie > ukryta) return false;
  return true;
}

// Nierozwiazane sprawy przy przesylce — krotkie etykiety dla listy roboczej i karty.
//
// Zasada „stan wymagajacy czlowieka nie moze zniknac z listy roboczej" jest w tym projekcie
// zapisana dwa razy (komentarz w status.js przy `do_wyjasnienia`, potem doZrobienia dla
// faktur), ale do przesylki JUZ NADANEJ nigdy jej nie zastosowano. A wlasnie tam boli
// najbardziej: `wyliczStatus` daje wtedy 'wyslane', wiec zamowienie schodzi z listy
// w tej samej sekundzie, w ktorej powstal problem.
//
// Scenariusz `sync_woo_blad`: paczka pojechala, ale sklep zostal na 'processing', wiec klient
// NIGDY nie dostal numeru listu. Automatycznego ponowienia nie ma (swiadomie, Zadanie 10),
// a ostrzezenie istnieje wylacznie na karcie, ktorej nikt nie ma powodu otwierac.
export function sprawyPrzesylki(p, teraz = Date.now()) {
  const stan = stanPrzesylki(p, teraz);
  if (stan === 'brak' || stan === 'blad') return [];
  const sprawy = [];
  if (stan === 'zawieszona') sprawy.push('nadanie zawieszone');
  // Przesylka czekajaca na numer u kuriera JEST sprawa dla czlowieka, mimo ze nic sie nie
  // zepsulo: panel sam po nia nie wroci (nie ma zadnego zadania w tle), wiec bez tej pozycji
  // zamowienie zeszloby z listy roboczej i lezalo z paczka bez numeru listu i bez etykiety,
  // dopoki ktos przypadkiem nie otworzylby karty. Zdejmuje ja „Sprawdz ponownie".
  if (stan === 'tworzona_u_kuriera') sprawy.push('przesyłka tworzona u kuriera');
  if (stan === 'do_wyjasnienia') sprawy.push('nadanie do wyjaśnienia');
  if (p.sync_woo_blad) sprawy.push('sklep niezsynchronizowany');
  // Brak pliku etykiety liczy sie DOPIERO przy przesylce nadanej: dopoki nadanie trwa,
  // etykiety jeszcze po prostu nie ma i nie jest to zadna sprawa do zalatwienia.
  // PDF i ZPL sa rownoprawnymi zapisanymi etykietami — WzA „Nadaj i drukuj” ma tylko ZPL.
  //
  // `etykieta_reczna` zdejmuje te sprawe TAK SAMO jak plik na dysku: to typowy skutek
  // domkniecia 'do_wyjasnienia' (DPD nie oddalo etykiety), a przed dorobieniem tego
  // znacznika NIC nie umialo tej odznaki zdjac — zamowienie zostawalo na liscie roboczej
  // na zawsze, mimo ze operator zalatwil sprawe (ma etykiete z panelu DPD albo z maila).
  //
  // `nadana_recznie` (przesylka zarejestrowana jako nadana POZA panelem) zdejmuje ja z INNEGO
  // powodu i to rozroznienie jest istotne: tam brak etykiety nie jest sprawa do zalatwienia,
  // tylko stanem Z DEFINICJI — panel nigdy nie rozmawial o tej paczce z DPD i nigdy zadnego
  // pliku nie dostanie. Zamowienie wisialoby na liscie roboczej bez zadnego sensownego
  // wyjscia, a jedynym „rozwiazaniem" byloby klikniecie „zalatwione recznie" po nic.
  if (stan === 'nadana' && !p.etykieta_sciezka && !p.etykieta_zpl_sciezka && !p.etykieta_reczna && !p.nadana_recznie) sprawy.push('brak etykiety');
  // PACZKA BEZ RUCHU (zegar #4, 23.08): ponad 3 dni ROBOCZE od ostatniego zdarzenia
  // kuriera (a bez zdarzen — od nadania: paczka potrafi zginac przed pierwszym skanem
  // i wlasnie wtedy nikt by jej nie szukal). Doreczona i zwrot nie stoja — regula w
  // domain/etap-przesylki.js, wspolna z zakladka /przesylki.
  //
  // ⚠️ UKRYCIE TLUMI TE SPRAWE — I TYLKO TE. Czlowiek, ktory kliknal „Ukryj" w zakladce
  // /przesylki, powiedzial „wiem o tej paczce i nic z niej nie bedzie" (zamowienie testowe,
  // etykieta nigdy niepodjeta). Gdyby ukrycie dzialalo tylko na liscie, zamowienie zostaloby
  // na liscie roboczej z odznaka, ktorej juz nic nie zdejmie — czyli sprzatanie byloby
  // polsrodkiem. Pozostale sprawy zostaja: ukrycie nie jest wylacznikiem listy roboczej.
  if (stan === 'nadana' && !przesylkaUkryta(p) && bezRuchu({
    etap: etapPrzesylki(p.status_kuriera, p.status_kuriera_kod),
    statusKurieraAt: p.status_kuriera_at,
    nadanaAt: p.utworzona_at,
    teraz: new Date(teraz),
  })) sprawy.push('paczka bez ruchu');
  // Znacznik kasuje sie sam przy najblizszym udanym odswiezeniu (zapiszProbeStatusuDpd),
  // wiec chwilowa awaria sieci nie zostawia zamowienia na liscie na zawsze.
  //
  // ⚠️ „u kuriera", a NIE „DPD" (Zadanie 9). Napis powstal, gdy kurier byl jeden — od
  // paczkomatow ta odznaka wisialaby przy przesylce, ktora nigdy do DPD nie pojechala,
  // i kierowalaby operatora do panelu niewlasciwego kuriera. Ktory to kurier, widac
  // w wierszu przesylki (`p.kurier`) i na karcie; odznaka na liscie ma byc krotka i prawdziwa.
  if (p.status_kuriera_blad) sprawy.push('status u kuriera niedostępny');
  return sprawy;
}

// Stany, z ktorych panel sam nie wyjdzie: rozstrzyga czlowiek po zajrzeniu do panelu DPD.
export function przesylkaWymagaCzlowieka(p, teraz = Date.now()) {
  return sprawyPrzesylki(p, teraz).length > 0;
}

// Sprawy CALEGO zamowienia, po dopuszczeniu wielu paczek.
//
// Zasada „stan wymagajacy czlowieka nie moze zniknac z listy roboczej" byla juz raz
// naprawiana (patrz komentarz wyzej) i dokladnie ona wraca tu jako pytanie: przy dwoch
// paczkach panel patrzacy tylko na pierwsza przestaje widziec problem drugiej. Dlatego
// sprawy licza sie PER PACZKA i sumuja — zamowienie wraca na liste robocza, jesli sprawa
// dotyczy KTOREJKOLWIEK.
//
// Prefiks „paczka N:" pojawia sie WYLACZNIE przy wielu paczkach. Przy jednej byloby
// szumem (nie ma czego rozrozniac), a przy dwoch jest jedyna informacja pozwalajaca
// operatorowi ruszyc z miejsca: „brak etykiety" bez numeru paczki nie mowi, gdzie patrzec.
export function sprawyZamowienia(przesylki, teraz = Date.now()) {
  const lista = przesylki ?? [];
  const wiele = lista.length > 1;
  return lista.flatMap((p) => sprawyPrzesylki(p, teraz)
    .map((s) => (wiele ? `paczka ${p.kolejnosc}: ${s}` : s)));
}

export function zamowienieWymagaCzlowieka(przesylki, teraz = Date.now()) {
  return (przesylki ?? []).some((p) => przesylkaWymagaCzlowieka(p, teraz));
}

// Czy wolno w ogole zaproponowac nadanie KOLEJNEJ paczki.
//
// Odpowiedz jest „nie" dokladnie wtedy, gdy o ktorejs paczce nie wiadomo, czy istnieje
// u kuriera: 'w_trakcie' to okno podwojnego klikniecia (wywolanie DPD wlasnie leci),
// a 'zawieszona' to sierota po restarcie procesu — tam czlowiek ma NAJPIERW zajrzec do
// panelu DPD i rozstrzygnac los tamtej paczki, a nie dokladac nastepnej.
//
// Paczka 'nadana' i 'do_wyjasnienia' NIE blokuja: obie na pewno istnieja u kuriera, wiec
// dosylka (zgubiona, uszkodzona) jest wtedy normalna, swiadoma decyzja operatora.
//
// 'tworzona_u_kuriera' BLOKUJE, choc o tej paczce wiadomo, ze istnieje — i to nie jest ta
// sama sytuacja co 'nadana'. Ta przesylka nie ma jeszcze ANI numeru listu, ANI etykiety,
// wiec dokladanie do niej kolejnej znaczyloby dwie paczki, z ktorych jednej nie da sie
// nawet nakleic. Najpierw „Sprawdz ponownie", potem ewentualna dosylka.
export const STANY_BLOKUJACE_KOLEJNA = ['w_trakcie', 'tworzona_u_kuriera', 'zawieszona'];

export function mozliwaKolejnaPaczka(przesylki, teraz = Date.now()) {
  return !(przesylki ?? []).some((p) => STANY_BLOKUJACE_KOLEJNA.includes(stanPrzesylki(p, teraz)));
}

// Podzbior spraw z `sprawyPrzesylki`, ktore panel umie zdjac JEDNYM kliknieciem — trasa
// „sprawa zalatwiona recznie" (POST /przesylki/:id/sprawa-zalatwiona). Celowo WYLACZNIE te
// dwie: 'nadanie zawieszone' i 'nadanie do wyjaśnienia' maja wlasne, odrebne wyjscia
// (odblokuj / domknij), a 'status DPD niedostepny' kasuje sie samo przy nastepnym udanym
// odswiezeniu — dotykanie go tu otworzyloby druga, niezamierzona droge do jego zdjecia.
//
// Zwraca identyfikatory (nie gotowe etykiety dla czlowieka) — db/przesylki.js uzywa ich
// do sterowania, ktore kolumny zaktualizowac, a trasa do zbudowania wpisu w logu.
export function sprawyDoZalatwieniaRecznie(p, teraz = Date.now()) {
  if (!p) return [];
  const stan = stanPrzesylki(p, teraz);
  const sprawy = [];
  if (p.sync_woo_blad) sprawy.push('sync_woo_blad');
  // `nadana_recznie` wykluczone tu z tego samego powodu, co w sprawyPrzesylki wyzej —
  // i dodatkowo po to, zeby karta nie kusila przyciskiem „zalatwione recznie" przy paczce,
  // przy ktorej nie ma czego zalatwiac (klikniecie odbiloby sie od 400).
  if (stan === 'nadana' && !p.etykieta_sciezka && !p.etykieta_zpl_sciezka && !p.etykieta_reczna && !p.nadana_recznie) sprawy.push('brak_etykiety');
  return sprawy;
}
