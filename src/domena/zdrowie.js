import { poPolsku } from './blad-po-polsku.js';

// ZDROWIE PANELU DLA CZUJKI — regula za GET /health, w calosci czysta (bez sieci, bez bazy,
// bez zegara: wszystko przychodzi argumentami).
//
// POWSTALA PO AUDYCIE 2026-08-22. Awaria DNS 17.08 polozyla panel na 2,5 godziny i wykryl ja
// czlowiek; kanal allegro_a 14.08 milczal od 23:34, a wlasciciel dowiedzial sie rano,
// bo nie dalo sie nadac paczki. Panel WIEDZIAL i nie powiedzial — czujka monitoring na
// Proxmoksie ma go teraz o to PYTAC, a ta funkcja jest odpowiedzia.
//
// ⚠️ ZRODLA PRAWDY SA TRZY I ROZNE — i to jest tresc tej funkcji, a nie przypadek:
//   • poller       → tabela stan_pollera (per sklep/kanal, kazdy przebieg bije znacznik,
//                    blad gasnie przy sukcesie; przezywa restart kontenera),
//   • czuwacz KSeF → puls w pamieci procesu (jedyny zegar bez zadnego sladu w bazie),
//   • koszty       → tabela stan_kosztow (ostatnie_udane_at bije takze PUSTA noc —
//                    patrz odnotujUdanyPrzebieg w db/koszty.js).
// Kanaly Allegro przychodza JUZ ocenione przez stanKanalu() z domain/kanal-stan.js —
// druga kopia tej reguly rozjechalaby sie z paskiem ostrzezen na liscie zamowien.
//
// ⚠️ TA FUNKCJA NIE MA PRAWA DOTKNAC SIECI. /health bedzie odpytywane co godzine przez
// czujke; jedno odswiezenie tokenu Allegro w tej sciezce SPALILOBY jednorazowy refresh token
// (awaria 14.08). Kanaly ida z bazy przez stanDlaEkranu(), nigdy przez klienta HTTP.

// Progi per zegar — kazdy z zapasem wzgledem wlasnego odstepu, zeby jedna czkawka sieci
// nie budzila telefonu w nocy:
//   poller chodzi co 2 min       → 15 min ciszy to realny postoj, nie czkawka;
//   czuwacz KSeF co godzine      → 3 h;
//   koszty raz na dobe (03:00)   → 26 h (doba + godzina zapasu na dlugi przebieg).
export const PROG_POLLERA_S = 15 * 60;
// ⚠️ DRUGI PROG POLLERA, O CZYMS INNYM NIZ PIERWSZY. `PROG_POLLERA_S` pyta „czy poller
// w ogole chodzi"; ten pyta „czy blad TRWA". Powstal po falszywym alarmie 08.09.2026:
// jeden przebieg `pro` padl na `fetch failed` o 19:05:32, czujka odpytala /health
// o 19:05:51 — dziewietnascie sekund pozniej — i obudzila telefon. Dwie minuty pozniej
// nastepny przebieg zgasil blad w bazie. Alarm byl nieaktualny, zanim dotarl.
//
// Skala z logu (04–09.09, 4,4 doby): 24 nieudane przebiegi na ~12 700, czyli 0,2%, KAZDY
// otwierajacy dwuminutowe okno `ok:false` przy czujce pytajacej raz na godzine. Alarm
// o czknieciu sieci byl wiec loteria 2/60 — a budzik, ktory 24 razy na 25 klamie, uczy
// nie czytac budzikow. 10 minut = piec nieudanych przebiegow z rzedu (decyzja wlasciciela
// 09.09.2026); najdluzsza seria w tamtych 4,4 doby miala dlugosc JEDEN.
export const PROG_BLEDU_POLLERA_S = 10 * 60;

// ⚠️⚠️ TRZECI PROG POLLERA — EKRANOWY, I MIERZY CO INNEGO NIZ DWA POPRZEDNIE (decyzja
// wlasciciela 10.09.2026: „komunikat po 3 nieudanych przebiegach z rzedu").
//
// Ekran i telefon to dwa rozne koszty falszywego alarmu. Budzik w nocy kosztuje tyle, ze
// woli sie spoznic (10 minut, ~5 przebiegow); wiersz na stronie, ktora i tak sie oglada,
// kosztuje spojrzenie — moze zapalic sie wczesniej. Ale NIE od pierwszej wpadki: to
// wlasnie ona 10.09.2026 kazala szukac awarii, ktorej juz nie bylo.
//
// ⚠️ LICZYMY PROBY, NIE MINUTY — i to jest cala roznica wobec `PROG_BLEDU_POLLERA_S`.
// Przy tyknieciu co 2 minuty „trzy przebiegi" wypadaja okolo czwartej minuty, wiec kusi,
// zeby zapisac tu `4 * 60` i nie zakladac kolumny. To bylby jednak PROG O CZYMS INNYM:
// czas plynie takze wtedy, gdy prob nie ma ani jednej (zawieszony przebieg blokuje
// nastepne przez `wTrakcie` w services/poller.js), a zmiana `ODSTEP_POLLERA_MS`
// przestawilaby znaczenie stalej po cichu. Licznik `stan_pollera.ostatni_blad_prob`
// mowi dokladnie to, o co poproszono.
export const PROB_BLEDU_NA_EKRAN = 3;

/**
 * Czy blad pollera nie ma jeszcze prawa OBUDZIC TELEFONU — prog czasu trwania.
 *
 * ⚠️ 'awaria' TAK, 'pominiecie' NIGDY. Zamowienie odrzucone przez mapowanie zostalo
 * przeskoczone przez kursor i samo z siebie NIE WROCI (services/poller.js,
 * `opisPominietych`), a blad gasnie przy najblizszym czystym przebiegu — czyli po
 * ~2 minutach. Dlawienie 10-minutowe nie opoznialoby tamtego alarmu, tylko kasowalo go
 * w calosci. Rodzaj nieznany (wiersz sprzed migracji albo z obcego zapisu) tez NIE jest
 * dlawiony: na braku wiedzy nie milczymy.
 */
export function czyDlawicAlarmPollera({ rodzaj = null, bladWiekS = null } = {}) {
  return rodzaj === 'awaria' && Number.isFinite(bladWiekS) && bladWiekS < PROG_BLEDU_POLLERA_S;
}

/**
 * Czy blad pollera nie ma jeszcze prawa POKAZAC SIE W PANELU — prog liczby prob.
 *
 * Ta sama zasada co wyzej dla rodzaju i dla braku wiedzy: `pominiecie` przechodzi zawsze,
 * a wiersz bez licznika (sprzed migracji z 10.09.2026) POKAZUJE blad.
 */
export function czyDlawicWierszPollera({ rodzaj = null, bladProb = null } = {}) {
  return rodzaj === 'awaria' && Number.isFinite(bladProb) && bladProb < PROB_BLEDU_NA_EKRAN;
}

/**
 * Licznik prob z wiersza bazy → liczba albo `null` („nie wiem").
 *
 * ⚠️⚠️ `Number(null)` TO ZERO, NIE NaN — i na tym polega cala potrzeba tej funkcji.
 * Wiersz sprzed migracji z 10.09.2026 ma w tej kolumnie NULL; goly `Number()` zamienialby
 * go w „zero prob", czyli w wartosc MNIEJSZA od progu — i blad, o ktorym nic nie wiemy,
 * zostalby ZDLAWIONY zamiast pokazany. Dokladnie odwrotnie do zasady „na braku wiedzy nie
 * chowamy". Zlapane 10.09.2026: w testach szlo `undefined` (→ NaN, poprawnie), a z bazy
 * przychodzi `null` — dwie rozne odpowiedzi na to samo pytanie.
 */
export function liczbaProbBledu(wartosc) {
  if (wartosc === null || wartosc === undefined || wartosc === '') return null;
  const n = Number(wartosc);
  return Number.isFinite(n) ? n : null;
}

/**
 * Blad pollera GOTOWY NA EKRAN — po polsku i bez czkniec — albo `null`, gdy nie ma o czym
 * mowic. Uzywa tego pasek synchronizacji na liscie zamowien (web/views/lista.ejs), zeby
 * mowil dokladnie to samo, co tabelka ostrzezen nad nim; dwie rozne odpowiedzi na tym
 * samym ekranie ucza ignorowania obu.
 *
 * Wejsciem jest SUROWY WIERSZ `stan_pollera` (tak, jak oddaje go poller.stan()), bo tam
 * stoja obie kolumny potrzebne do oceny: `ostatni_blad_prob` i `ostatni_blad_rodzaj`.
 */
export function bladPolleraNaEkran(stan) {
  const blad = String(stan?.ostatni_blad ?? '').trim();
  if (!blad) return null;
  const dlawione = czyDlawicWierszPollera({
    rodzaj: stan?.ostatni_blad_rodzaj ?? null,
    bladProb: liczbaProbBledu(stan?.ostatni_blad_prob),
  });
  return dlawione ? null : poPolsku(blad);
}

export const PROG_CZUWACZA_KSEF_S = 3 * 3600;
export const PROG_KOSZTOW_S = 26 * 3600;
// Zegar #4 (sledzenie paczek, od 23.08) chodzi co godzine jak KSeF — ten sam zapas.
export const PROG_PRZESYLEK_S = 3 * 3600;
// Zegar #6 (czuwacz ostrzezen, od 29.08: lustra luk KSeF i terminow platnosci dla
// tabelki na stronie glownej) chodzi co godzine — ten sam zapas.
export const PROG_OSTRZEZEN_S = 3 * 3600;

const wiekS = (teraz, isoAlboDate) => {
  if (!isoAlboDate) return null;
  const t = new Date(isoAlboDate).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((teraz.getTime() - t) / 1000);
};

// Znacznik do odpowiedzi. ⚠️ Nigdy nie rzuca: `/health` ma odpowiedzieć nawet z zepsutym
// wejściem, bo cisza na tej trasie jest dla czujki nieodróżnialna od leżącego panelu.
const naIso = (isoAlboDate) => {
  if (!isoAlboDate) return null;
  const t = new Date(isoAlboDate).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

// Eksportowane od 2026-08-29: strona główna (domain/ostrzezenia.js) formatuje wiek
// zegarów TYM SAMYM przelicznikiem, co /health — dwie kopie rozjechałyby się przy
// pierwszej zmianie progu godzin.
export const fmtWiek = (s) => (s >= 7200 ? `${Math.floor(s / 3600)} h` : `${Math.floor(s / 60)} min`);

// Wspolna ocena zegara zyjacego WYLACZNIE pulsem (czuwacz KSeF, czuwacz przesylek):
// brak sladu w bazie, wiec mlody proces czeka, zawieszony sie starzeje, a blad swiezszy
// niz sukces alarmuje trescia.
function ocenaZegaraZPulsu({ nazwa, wlaczony, puls, progS, procesWiekS, teraz, alarmy }) {
  // ⚠️ `bladSwiezszy` JEST W WYNIKU, a nie tylko w tej funkcji — bo `blad` bywa PAMIATKA.
  // Puls trzyma ostatni slad bledu takze wtedy, gdy pozniejszy przebieg sie udal, wiec
  // renderer, ktory zacytuje `blad` bez tego pola, opowie o usterce JUZ NIEAKTUALNEJ
  // (domain/ostrzezenia.js, zdanieZegara — zgloszenie wlasciciela z 10.09.2026).
  const wynik = {
    wlaczony: Boolean(wlaczony), zdrowy: true, okAt: null, wiekS: null,
    blad: null, bladAt: null, bladSwiezszy: false,
  };
  if (!wlaczony) return wynik;
  const okAt = puls?.okAt ?? null;
  const bladAt = puls?.bladAt ?? null;
  wynik.okAt = okAt;
  wynik.bladAt = bladAt;
  wynik.blad = poPolsku(puls?.blad ?? null);
  wynik.wiekS = wiekS(teraz, okAt);
  if (!okAt) {
    // Bez ani jednego sukcesu KAZDY blad jest biezacy — nie ma czego uznac za nowsze.
    wynik.bladSwiezszy = Boolean(bladAt);
    if (procesWiekS > progS) {
      wynik.zdrowy = false;
      alarmy.push(`${nazwa}: ani jednego udanego przebiegu od startu procesu (${fmtWiek(procesWiekS)} temu)`);
    }
    return wynik;
  }
  const bladSwiezszy = Boolean(bladAt) && new Date(bladAt).getTime() > new Date(okAt).getTime();
  wynik.bladSwiezszy = bladSwiezszy;
  if (bladSwiezszy) {
    wynik.zdrowy = false;
    alarmy.push(`${nazwa}: ostatni przebieg zakończył się błędem — ${wynik.blad ?? 'bez treści'}`);
  }
  if (wynik.wiekS > progS) {
    wynik.zdrowy = false;
    alarmy.push(`${nazwa}: ostatni udany przebieg ${fmtWiek(wynik.wiekS)} temu (próg ${fmtWiek(progS)})`);
  }
  return wynik;
}

export function ocenZdrowie({
  teraz, startAt,
  zrodla = [], stanyPollera = [],
  ksefWlaczony = false, pulsKsef = null,
  przesylkiWlaczone = false, pulsPrzesylek = null,
  ostrzezeniaWlaczone = false, pulsOstrzezen = null,
  kosztyWlaczone = false, kosztyModulWylaczony = false, kosztyWlaczoneOd = /** @type {string | null} */ (null), stanKosztow = null,
  kanaly = [],
}) {
  const alarmy = [];
  const uwagi = [];
  // ⚠️ DWIE POSTACI TEJ SAMEJ LICZBY, i różnica jest treścią. `procesWiekSurowy` bywa
  // `null` („nie wiem, kiedy wstałem") i taki idzie do odpowiedzi; `procesWiekS` schodzi
  // do zera na potrzeby PROGÓW, bo tam brak wiedzy ma znaczyć „młody, poczekaj”, a nie
  // wysypać porównanie. Wpisanie zera do odpowiedzi mówiłoby czujce „proces właśnie
  // wstał” — czyli dokładnie nieprawdę, po którą to pole powstało.
  const procesWiekSurowy = wiekS(teraz, startAt);
  const procesWiekS = procesWiekSurowy ?? 0;

  // POLLER — per zrodlo z listy SKONFIGUROWANYCH, nigdy z samych wierszy bazy: wiersz,
  // ktory przestal powstawac, wyglada w bazie identycznie jak kanal wygaszony — a to
  // wlasnie brak krzyku najlatwiej pomylic ze spokojem. Wiersze zrodel wygaszonych
  // (sa w bazie, nie ma ich w konfiguracji) pomijamy z tego samego powodu w druga strone.
  const wierszePollera = new Map((stanyPollera ?? []).map((w) => [w.sklep, w]));
  const zrodlaPollera = zrodla.map((zrodlo) => {
    const w = wierszePollera.get(zrodlo);
    if (!w) {
      const mlody = procesWiekS < PROG_POLLERA_S;
      if (!mlody) alarmy.push(`poller ${zrodlo}: panel nie zna stanu — ani jednego przebiegu w bazie`);
      return {
        zrodlo, ostatniPrzebiegAt: null, wiekS: null, blad: null, zdrowy: mlody,
      };
    }
    const wiek = wiekS(teraz, w.ostatni_przebieg_at);
    // Tresc bledu idzie na ekran i na telefon, wiec PO POLSKU (domain/blad-po-polsku.js).
    // W bazie zostaje oryginal — patrz uzasadnienie w tamtym pliku.
    const blad = poPolsku(String(w.ostatni_blad ?? '').trim() || null);
    const bladOdAt = w.ostatni_blad_od_at ?? null;
    const bladWiek = wiekS(teraz, bladOdAt);
    // Licznik nieudanych przebiegow z rzedu (services/poller.js). Wiersz sprzed migracji
    // z 10.09.2026 go nie ma — `null` znaczy „nie wiem" i regula nizej wtedy NIE dlawi.
    const bladProb = liczbaProbBledu(w.ostatni_blad_prob);
    let zdrowy = true;
    if (blad) {
      // ⚠️⚠️ DWA PROGI, DWA ADRESATY — i to jest cala tresc tej galezi (10.09.2026).
      //
      // Do 09.09 stalo tu `zdrowy = false` przy KAZDYM bledzie: czknieccie sieci milczalo
      // na telefonie, ale malowalo czerwony wiersz na stronie glownej od pierwszej sekundy.
      // Zgloszenie wlasciciela z 10.09.2026 pokazalo, ile to warte: zobaczyl „Poller
      // allegro_b nie działa: The operation was aborted due to timeout", poszedl
      // do Ustawien → Łączność, tam bylo ZIELONO — bo dwie minuty wczesniej nastepny
      // przebieg zgasil blad w bazie. Wiersz opowiadal o usterce, ktorej juz nie bylo.
      //
      // Prog jest jednak INNY dla kazdego z adresatow, bo inny jest koszt pomylki:
      //   • EKRAN   — po TRZECH nieudanych przebiegach z rzedu (`PROB_BLEDU_NA_EKRAN`).
      //               Czyta go tabelka ostrzezen i pasek na liscie zamowien.
      //   • TELEFON — po 10 minutach TRWANIA (`PROG_BLEDU_POLLERA_S`, decyzja z 09.09).
      //               Budzik ma prawo sie spoznic; nie ma prawa klamac.
      //
      // ⚠️ TO NIE JEST ZIELEN NA SILE. Blad wciaz JEST w wyniku (`blad`, `bladOdAt`,
      // `bladWiekS`, `bladProb`) i wciaz widac go w /health; dlawimy WYLACZNIE to, co
      // krzyczy do czlowieka. Najdluzsza seria zmierzona w logu (04–09.09, 4,4 doby)
      // miala dlugosc JEDEN, wiec prog trzech prob nie przepusci ani jednego czknieccia
      // z tamtego okresu.
      if (!czyDlawicWierszPollera({ rodzaj: w.ostatni_blad_rodzaj, bladProb })) {
        zdrowy = false;
      }
      if (!czyDlawicAlarmPollera({ rodzaj: w.ostatni_blad_rodzaj, bladWiekS: bladWiek })) {
        // Czas trwania w tresci, bo to on odroznia postoj od czknieccia — a czlowiek czyta
        // to zdanie na ekranie telefonu, bez dostepu do bazy.
        const odKiedy = bladWiek != null ? ` (trwa ${fmtWiek(bladWiek)})` : '';
        alarmy.push(`poller ${zrodlo}: ${blad}${odKiedy}`);
      }
    }
    if (wiek == null || wiek > PROG_POLLERA_S) {
      // ⚠️ POZA `else` I POZA DLAWIENIEM — poller, ktory NIE CHODZI, to inna awaria niz
      // poller, ktory chodzi i dostaje bledy. Gdyby swiezy blad wyciszal takze te regule,
      // zawieszony poller z jednym bledem w bazie stalby sie niewidzialny.
      zdrowy = false;
      alarmy.push(`poller ${zrodlo}: ostatni przebieg ${wiek == null ? 'nieznany' : `${fmtWiek(wiek)} temu`} (próg ${fmtWiek(PROG_POLLERA_S)})`);
    }
    return {
      zrodlo,
      ostatniPrzebiegAt: w.ostatni_przebieg_at ?? null,
      wiekS: wiek,
      blad,
      bladOdAt,
      bladWiekS: bladWiek,
      bladProb,
      zdrowy,
    };
  });

  // CZUWACZE ZYJACE PULSEM (KSeF i przesylki) — wspolna ocena wyzej. Brak wpisu przy
  // mlodym procesie to stan POPRAWNY (pierwszy przebieg dopiero za niecala godzine);
  // przy starym — czuwacz nie przebiegl ani razu, czyli dokladnie ta awaria
  // `if (false && czuwaczKsef)`, ktorej grep nie widzial.
  const czuwaczKsef = ocenaZegaraZPulsu({
    nazwa: 'czuwacz KSeF', wlaczony: ksefWlaczony, puls: pulsKsef,
    progS: PROG_CZUWACZA_KSEF_S, procesWiekS, teraz, alarmy,
  });
  const czuwaczPrzesylek = ocenaZegaraZPulsu({
    nazwa: 'czuwacz przesyłek', wlaczony: przesylkiWlaczone, puls: pulsPrzesylek,
    progS: PROG_PRZESYLEK_S, procesWiekS, teraz, alarmy,
  });
  const czuwaczOstrzezen = ocenaZegaraZPulsu({
    nazwa: 'czuwacz ostrzeżeń', wlaczony: ostrzezeniaWlaczone, puls: pulsOstrzezen,
    progS: PROG_OSTRZEZEN_S, procesWiekS, teraz, alarmy,
  });

  // CZUWACZ KOSZTOW — stan_kosztow. Obecnosc bledu WYSTARCZA za alarm: baza gasi go przy
  // najblizszym udanym przebiegu (zapiszKursor / odnotujUdanyPrzebieg), wiec blad w wierszu
  // to z definicji stan biezacy, a nie pamiatka.
  const czuwaczKosztow = {
    wlaczony: Boolean(kosztyWlaczone), zdrowy: true, ostatnieUdaneAt: null, wiekS: null, blad: null, bladAt: null,
    // PRZ-102.22: dlaczego czuwacz stoi — moduł wyłączony w Ustawienia → Moduły to stan zamierzony, nie awaria
    // (bez alarmu i bez uwagi, żeby czujka nie budziła co dobę o decyzji właściciela).
    stan: kosztyModulWylaczony ? 'koszty wyłączone' : kosztyWlaczone ? 'pobiera z KSeF' : 'brak tokenu KSeF',
  };
  // PRZ-102.22 (recenzja): próg liczy się od PÓŹNIEJSZEJ z dwóch chwil — ostatniego udanego pobrania albo włączenia
  // pobierania (zapis tokenu w Ustawieniach, włączenie modułu Koszty). Pobranie chodzi raz na dobę o 3:00, więc
  // pobieranie włączone w dzień nie miało jeszcze szansy — bez tego /health wisiałby na alarmie do nocy. Pole `wiekS`
  // w odpowiedzi zostaje wiekiem OSTATNIEGO UDANEGO pobrania (czujka i ekran czytają je jak dotąd).
  const odWlaczeniaS = wiekS(teraz, kosztyWlaczoneOd);
  const mlodszy = (a, b) => (a == null ? b : b == null ? a : Math.min(a, b));
  if (kosztyWlaczone) {
    if (!stanKosztow) {
      if (mlodszy(procesWiekS, odWlaczeniaS) > PROG_KOSZTOW_S) {
        czuwaczKosztow.zdrowy = false;
        alarmy.push('czuwacz kosztów: ani jednego przebiegu w bazie, a proces stoi dłużej niż dobę');
      }
    } else {
      czuwaczKosztow.ostatnieUdaneAt = stanKosztow.ostatnie_udane_at ?? null;
      czuwaczKosztow.wiekS = wiekS(teraz, stanKosztow.ostatnie_udane_at);
      czuwaczKosztow.blad = poPolsku(String(stanKosztow.ostatni_blad ?? '').trim() || null);
      czuwaczKosztow.bladAt = stanKosztow.ostatni_blad_at ?? null;
      if (czuwaczKosztow.blad) {
        czuwaczKosztow.zdrowy = false;
        alarmy.push(`czuwacz kosztów: ${czuwaczKosztow.blad}`);
      }
      const wiekProgu = mlodszy(czuwaczKosztow.wiekS, odWlaczeniaS);
      if (wiekProgu == null || wiekProgu > PROG_KOSZTOW_S) {
        czuwaczKosztow.zdrowy = false;
        alarmy.push(`czuwacz kosztów: ostatnie udane pobranie ${czuwaczKosztow.wiekS == null ? 'nieznane' : `${fmtWiek(czuwaczKosztow.wiekS)} temu`} (próg ${fmtWiek(PROG_KOSZTOW_S)})`);
      }
    }
  }

  // KANALY ALLEGRO — ocena przyszla z zewnatrz (stanKanalu). Pilne = alarm; uprzedzenie
  // („token wygasa za N dni") = uwaga: kanal DZIALA, a czujka ma wlasna, rzadsza kadencje
  // dla uwag, zeby siedem dni uprzedzenia nie znaczylo czternastu budzikow.
  const kanalyWynik = (kanaly ?? []).map((k) => ({
    kanal: k.kanal ?? null,
    zyje: Boolean(k.zyje),
    pilne: Boolean(k.pilne),
    uprzedzenie: Boolean(k.uprzedzenie),
    zostaloDni: k.zostaloDni ?? null,
    refreshWygasaAt: k.refreshWygasaAt ?? null,
    powod: k.powod ?? null,
  }));
  for (const k of kanalyWynik) {
    if (k.pilne) alarmy.push(k.powod ?? `kanał ${k.kanal ?? '?'}: wymaga uwagi`);
    else if (k.uprzedzenie && k.powod) uwagi.push(k.powod);
  }

  return {
    ok: alarmy.length === 0,
    alarmy,
    uwagi,
    poller: { zdrowy: zrodlaPollera.every((z) => z.zdrowy), zrodla: zrodlaPollera },
    czuwaczKsef,
    czuwaczPrzesylek,
    czuwaczOstrzezen,
    czuwaczKosztow,
    kanaly: kanalyWynik,
    // MOMENT STARTU PROCESU (2026-09-10). Panel znał tę liczbę od początku — `procesWiekS`
    // decyduje, czy młody proces ma czekać zamiast krzyczeć alarmem w pierwszej minucie po
    // restarcie — ale jej nie oddawał. Bez niej z zewnątrz NIE DA SIĘ odróżnić restartu
    // panelu od zadławienia sieci: jedno i drugie wygląda jak cisza na /health. Bot
    // diagnozujący awarie pisał wprost „nie odróżnię restartu kontenera od zadławienia
    // sieci"; odpowiedź siedziała w tym procesie przez cały czas.
    //
    // ⚠️⚠️ TO POLE STOI NA KOŃCU I MUSI TU ZOSTAĆ. Czujka `monitoring.sh` nie parsuje
    // JSON-a, tylko wycina treść sedem po SĄSIEDZTWIE kluczy (`"uwagi":[…],"poller"`).
    // Pierwsza wersja tej zmiany wstawiła `proces` dokładnie między `uwagi` a `poller`:
    // nic by nie krzyknęło, a czujka przestałaby podawać POWÓD uwagi i wysyłała ogólnik.
    // Nowe pola dokładać PRZED `ok` albo PO `poller` — pilnują tego dwa testy „kolejność
    // kluczy jest umową z czujką".
    //
    // ⚠️ Trasa jest OTWARTA (4.40), więc to pole jest publiczne w LAN-ie. Czas startu
    // procesu jest metadaną — nie danymi klienta i nie sekretem — i takie ma zostać.
    proces: { startAt: naIso(startAt), wiekS: procesWiekSurowy },
  };
}
