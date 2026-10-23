// PRZ-108.07 (zmiana B planu automatyzacji, sekcja 5): silnik reguł „zdarzenie → warunki → akcja”.
//
// Jeden przebieg (zegar co 60 s, strażnik „jeden przebieg naraz”):
//  1. Brak włączonych reguł → wyjście po JEDNYM SELECT, przed jakimkolwiek zapisem. Instalacja z zerem reguł nie
//     zapisuje nic (dowód: tests/moduly/automatyzacje/silnik.test.js, total_changes()).
//  2. Wykrycie: dla każdej włączonej i niewstrzymanej reguły `zdarzenie.kandydaci(db, { granica, od, limit })`, filtr
//     kanału (BIAŁA LISTA — obce kanały nie trafiają do dziennika), `zaplanuj` (UNIQUE + ponowne otwarcie tylko
//     pominiętych i tylko nowszym zdarzeniem), bezpiecznik >50 naraz → wstrzymanie, kursor = chwila przebiegu.
//  3. Wysyłka należnych: reguła wyłączona → pominięte; przeterminowane (48 h od TERMINU) → pominięte; limity 20/h
//     reguły i 100/h OMS-u → czeka; zamówienie dołączone → pominięte; warunki W CHWILI WYKONANIA → pominięte z powodem;
//     brak poczty → pominięte; zgoda akcji → pominięte; rezerwacja `w_toku` (BEGIN IMMEDIATE) i dopiero potem akcja.
//  4. Błąd akcji: chwilowy błąd poczty przed przyjęciem listu → ponowienie za 15 min (najwyżej 3 próby, potem błąd);
//     każdy inny → `niepewne`, bez ponowienia.
// Rejestry zdarzeń i akcji są parametrem — w zmianie B oba puste (moduł), w testach sztuczne.
import {
  czyPasujeKanalom, odczytKursora, nowyKursor, terminWykonania, czyPrzeterminowane, klasyfikujBladPoczty, godzineWczesniej,
  ponowienieOd, maWarunkiWykonania, BEZPIECZNIK_NARAZ, LIMIT_OMS_NA_GODZINE, LIMIT_KANDYDATOW, MAKS_PROB,
} from '../../../domena/automatyzacje.js';
import {
  czySaWlaczone, wlaczoneReguly, regulaRozpakowana, wstrzymajRegule, zapiszKursor, POWOD_KANAL_ODZNACZONY,
} from '../db/reguly.js';
import {
  wTransakcji, zaplanuj, doWykonania, zarezerwuj, zakoncz, ponow, oznaczPrzerwane, licznikGodziny,
} from '../db/wykonania.js';
import { opisBleduPocztyDoLogu } from '../../wiadomosci/poczta-ustawien.ts';

const ZMIANY = 'SELECT total_changes() AS n';
const komunikat = (e) => (e instanceof Error ? e.message : String(e));
// PRZ-109.12: błąd transportu poczty (znacznik z usługi wiadomości) niesie w `message` odpowiedź serwera, a w niej
// login skrzynki — do logu zamówienia i dziennika wykonań idzie tylko kod i zdanie, jak w `wiadomosc.blad`.
const opisBleduWysylki = (e) => (e?.zTransportuPoczty ? opisBleduPocztyDoLogu(e) : komunikat(e));

/**
 * Warunki w chwili wykonania, gdy nikt nie podał sprawdzacza (zmiana B; prawdziwy — status, numer listu, dostawa,
 * pobranie — wchodzi w C1). Reguła bez warunków poza kanałem przechodzi; każdy inny warunek jest NIESPEŁNIONY:
 * lepiej pominąć z powodem niż wysłać maila, którego warunku nikt nie sprawdził.
 */
export async function warunkiBezSprawdzacza({ regula }) {
  if (!maWarunkiWykonania(regula.warunki)) return { ok: true };
  return { ok: false, kod: 'warunek', powod: 'Tej wersji OMS-u brakuje sprawdzania warunków reguły — mail pominięty.' };
}

/**
 * @param {{ db: any, zdarzenia?: readonly any[], akcje?: readonly any[], sprawdzWarunki?: (o: any) => Promise<any>,
 *   pocztaGotowa?: () => boolean, teraz?: () => Date, log?: (...t: string[]) => void }} opcje
 */
export function createSilnikAutomatyzacji({
  db, zdarzenia = [], akcje = [], sprawdzWarunki = warunkiBezSprawdzacza, pocztaGotowa = () => false,
  teraz = () => new Date(), log = () => {},
}) {
  const rejestrZdarzen = new Map(zdarzenia.map((z) => [z.klucz, z]));
  const rejestrAkcji = new Map(akcje.map((a) => [a.klucz, a]));
  const warunki = sprawdzWarunki ?? warunkiBezSprawdzacza;
  let trwa = false;
  let poStarcieZrobione = false;

  function wykryj(regula, chwila) {
    const zdarzenie = rejestrZdarzen.get(regula.zdarzenie);
    if (!zdarzenie) return { nowe: 0, otwarte: 0 }; // zdarzenie niedostępne w tej wersji — reguła nic nie robi
    const { od, po } = odczytKursora(regula);
    // PRZ-108.08: detektor dostaje białą listę kanałów (obce kanały nie zajmują limitu kandydatów) i id reguły
    // (paczki nie mają znacznika chwili przejścia w „nadana” — detektor pomija te, które reguła już ma).
    const kandydaci = zdarzenie.kandydaci(db, { granica: regula.granica, od, po, parametr: regula.zdarzenie_param,
      limit: LIMIT_KANDYDATOW, kanaly: Array.isArray(regula.warunki?.kanaly) ? regula.warunki.kanaly : [], regula_id: regula.id });
    const pasujace = kandydaci.filter((k) => czyPasujeKanalom(k.sklep, regula.warunki));
    const wykryte = chwila.toISOString();
    return wTransakcji(db, () => {
      let nowe = 0, otwarte = 0;
      for (const k of pasujace) {
        const wynik = zaplanuj(db, {
          regula_id: regula.id, przedmiot: k.przedmiot ?? `zamowienie:${k.zamowienie_id}`, zamowienie_id: k.zamowienie_id,
          przesylka_id: k.przesylka_id ?? null, zdarzenie_at: k.zdarzenie_at,
          termin_at: terminWykonania(k.zdarzenie_at, regula.opoznienie_min), szablon: regula.akcja_param?.szablon ?? null,
          teraz: wykryte,
        });
        if (wynik === 'nowe') nowe += 1;
        else if (wynik === 'otwarte') otwarte += 1;
      }
      // Bezpiecznik: tyle naraz to błąd albo import historii. Wykonania zostają zaplanowane (przyciski „Wyślij
      // zaległe (N)” / „Pomiń zaległe”), ale nic nie wychodzi, dopóki admin nie zdecyduje.
      if (nowe + otwarte > BEZPIECZNIK_NARAZ) {
        const powod = `${nowe + otwarte} zamówień naraz w jednym sprawdzeniu (więcej niż ${BEZPIECZNIK_NARAZ}) — możliwy błąd albo import historii.`;
        wstrzymajRegule(db, regula.id, powod);
        log(`automatyzacje: reguła „${regula.nazwa}” WSTRZYMANA — ${powod}`);
      }
      // Kursor = chwila przebiegu sprzed odczytu kandydatów; zakładka 5 min w odczytKursora łapie spóźnione zapisy.
      // Przy obciętej liście kursor złożony: następny przebieg czyta ŚCIŚLE po (zdarzenie_at, id) ostatniego kandydata.
      zapiszKursor(db, regula.id, nowyKursor({ chwila: wykryte, od, kandydaci }));
      return { nowe, otwarte };
    });
  }

  const pominiete = (w, regula, powod_kod, powod) => {
    zakoncz(db, w, { stan: 'pominiete', powod, powod_kod, teraz: teraz().toISOString(), nazwa: regula.nazwa });
    return 'pominiete';
  };

  /** Sprawdzenia synchroniczne tuż przed rezerwacją: stan reguły i limity mogły się zmienić w trakcie `await`. */
  function przedRezerwacja(w) {
    const regula = regulaRozpakowana(db, w.regula_id);
    if (!regula || regula.wlaczona !== 1 || regula.usunieta_at) {
      return { koniec: pominiete(w, regula ?? { nazwa: '?' }, 'regula_wylaczona', 'Reguła została wyłączona, zanim nadszedł termin.') };
    }
    if (regula.wstrzymana_powod) return { koniec: 'czeka' };
    // Kanał drugi raz, tuż przed rezerwacją: admin mógł odznaczyć kanał w regule po wykryciu (recenzja 07, usterka 5).
    const sklep = db.prepare('SELECT sklep FROM zamowienia WHERE id = ?').get(w.zamowienie_id)?.sklep;
    if (!czyPasujeKanalom(sklep, regula.warunki)) {
      return { koniec: pominiete(w, regula, 'kanal_odznaczony', POWOD_KANAL_ODZNACZONY) };
    }
    const chwila = teraz();
    if (czyPrzeterminowane(w.termin_at, chwila)) {
      return { koniec: pominiete(w, regula, 'przeterminowane', 'Minęło ponad 48 godzin od planowanej chwili wysyłki (OMS był wyłączony?). Mail po takim czasie bardziej myli, niż pomaga.') };
    }
    const od = godzineWczesniej(chwila);
    if (licznikGodziny(db, { od }) >= LIMIT_OMS_NA_GODZINE) return { koniec: 'limit_oms' };
    if (licznikGodziny(db, { od, regula_id: regula.id }) >= regula.limit_na_godzine) return { koniec: 'czeka' };
    return { regula };
  }

  async function wykonaj(w) {
    let { regula, koniec } = przedRezerwacja(w);
    if (koniec) return koniec;
    const akcja = rejestrAkcji.get(regula.akcja);
    if (!akcja) return pominiete(w, regula, 'akcja_niedostepna', 'Akcja tej reguły jest niedostępna w tej wersji OMS-u.');
    const zam = db.prepare('SELECT id, scalone_do FROM zamowienia WHERE id = ?').get(w.zamowienie_id);
    if (zam?.scalone_do) {
      return pominiete(w, regula, 'dolaczone', `Zamówienie dołączone do zamówienia ${zam.scalone_do} — wiadomość idzie z głównego.`);
    }
    // Warunki W CHWILI WYKONANIA (po opóźnieniu), nie przy wykryciu: cofnięty status pomija maila z powodem.
    const warunek = await warunki({ db, regula, wykonanie: w });
    if (!warunek?.ok) return pominiete(w, regula, warunek?.kod ?? 'warunek', warunek?.powod ?? 'Warunek reguły nie jest spełniony.');
    if (akcja.wymagaPoczty && !pocztaGotowa()) {
      return pominiete(w, regula, 'brak_poczty', 'brak poczty wychodzącej — podłącz ją w Ustawienia → Integracje → Poczta wychodząca.');
    }
    if (akcja.zgoda) {
      const zgoda = await akcja.zgoda({ db, regula, wykonanie: w });
      if (!zgoda?.ok) return pominiete(w, regula, zgoda?.kod ?? 'odmowa', zgoda?.powod ?? 'Akcja odmówiła wykonania.');
    }
    ({ regula, koniec } = przedRezerwacja(w));
    if (koniec) return koniec;
    if (!zarezerwuj(db, w.id)) return 'zajete';
    try {
      const wynik = await akcja.wykonaj({ db, regula, wykonanie: w });
      zakoncz(db, w, { stan: 'wyslane', adresat: wynik?.adresat ?? null, teraz: teraz().toISOString(), nazwa: regula.nazwa });
      return 'wyslane';
    } catch (e) {
      // PRZ-108.08: akcja odmówiła, ZANIM cokolwiek wyszło (np. treść nie dała się złożyć — szablon zmieniony
      // w międzyczasie). To pewny brak maila, nie „niepewne”: błąd z powodem, bez ponowienia.
      if (e?.przedWysylka) {
        zakoncz(db, w, { stan: 'blad', powod: `Nie udało się przygotować wiadomości: ${komunikat(e)} — nic nie poszło do klienta.`,
          powod_kod: 'zlozenie', teraz: teraz().toISOString(), nazwa: regula.nazwa });
        return 'blad';
      }
      const proby = w.proby + 1;
      if (klasyfikujBladPoczty(e) === 'ponow') {
        if (proby < MAKS_PROB) {
          ponow(db, w, { nastepna: ponowienieOd(teraz()), powod: `Próba ${proby} nieudana: ${opisBleduWysylki(e)}` });
          return 'ponowione';
        }
        zakoncz(db, w, { stan: 'blad', proby, powod: `${MAKS_PROB} próby nieudane — serwer poczty nie przyjął wiadomości (${opisBleduWysylki(e)}).`,
          powod_kod: 'poczta', teraz: teraz().toISOString(), nazwa: regula.nazwa });
        return 'blad';
      }
      zakoncz(db, w, { stan: 'niepewne', powod: `Błąd w trakcie wysyłki (${opisBleduWysylki(e)}). Nie ponawiamy — sprawdź, czy klient dostał wiadomość.`,
        powod_kod: 'niepewne', teraz: teraz().toISOString(), nazwa: regula.nazwa });
      return 'niepewne';
    }
  }

  /**
   * Wyjątek przy jednym wykonaniu nie może zatrzymać kolejki (recenzja 07, usterka 4). Przed rezerwacją (wiersz dalej
   * `zaplanowane`) → `pominiete` z kodem `blad_wewnetrzny`, wpisem w historii zamówienia i linią w logu. Po rezerwacji
   * wiersz zostaje `w_toku` — przy następnym starcie przejdzie w `niepewne` (akcja mogła wyjść).
   */
  async function wykonajBezpiecznie(w) {
    try { return await wykonaj(w); }
    catch (e) {
      log(`automatyzacje: wykonanie ${w.id} (zamówienie ${w.zamowienie_id}): ${komunikat(e)}`);
      const nazwa = regulaRozpakowana(db, w.regula_id)?.nazwa ?? '?';
      const zmienione = zakoncz(db, w, { stan: 'pominiete', powod_kod: 'blad_wewnetrzny', zeStanow: ['zaplanowane'],
        powod: `Błąd wewnętrzny OMS-u przy sprawdzaniu (${komunikat(e)}) — nic nie wysłano.`, teraz: teraz().toISOString(), nazwa });
      return zmienione ? 'blad_wewnetrzny' : 'wyjatek';
    }
  }

  async function przebieg() {
    if (trwa) return { pominiety: true };
    trwa = true;
    try {
      // Restart w trakcie wysyłki: `w_toku` → `niepewne` przy PIERWSZYM przebiegu zegara, nie przy budowie aplikacji —
      // skrypt budujący aplikację na tej samej bazie nie przestawi trwającej wysyłki serwera (recenzja 07, usterka 8).
      if (!poStarcieZrobione) poStarcie();
      const przed = db.prepare(ZMIANY).get().n;
      if (!czySaWlaczone(db)) return { wlaczonych: 0, zapisow: db.prepare(ZMIANY).get().n - przed };
      const chwila = teraz();
      const reguly = wlaczoneReguly(db);
      const wynik = { wlaczonych: reguly.length, nowe: 0, otwarte: 0, wyniki: {} };
      for (const regula of reguly.filter((r) => !r.wstrzymana_powod)) {
        try {
          const w = wykryj(regula, chwila);
          wynik.nowe += w.nowe;
          wynik.otwarte += w.otwarte;
        } catch (e) { log(`automatyzacje: wykrycie reguły „${regula.nazwa}”: ${komunikat(e)}`); }
      }
      const chwilaWysylki = teraz();
      for (const w of doWykonania(db, { teraz: chwilaWysylki.toISOString(), godzineWczesniej: godzineWczesniej(chwilaWysylki) })) {
        const stan = await wykonajBezpiecznie(w);
        wynik.wyniki[stan] = (wynik.wyniki[stan] ?? 0) + 1;
        if (stan === 'limit_oms') break;
      }
      return wynik;
    } finally { trwa = false; }
  }

  /** Start procesu: wiszące `w_toku` → `niepewne` (bez wiszących — zero zapisów). Woła go pierwszy przebieg. */
  function poStarcie() {
    // Flaga dopiero po udanym zapisie: wyjątek (np. zablokowana baza) → następny przebieg próbuje jeszcze raz
    // (recenzja 07, runda 2, R2-1 — inaczej `w_toku` wisiałoby do restartu i zajmowało limit godzinowy reguły).
    const n = oznaczPrzerwane(db, teraz().toISOString());
    poStarcieZrobione = true;
    return n;
  }

  return { przebieg, poStarcie };
}

/**
 * Podgląd „Sprawdź na ostatnich 30 dniach”: `zdarzenie.symulacja(db, od)` → kanał → warunki → zgoda akcji. ZERO zapisów
 * (test: total_changes()). Warunki i zgodę liczy według stanu z dziś — ekran to mówi.
 */
export async function symulujRegule({ db, regula, zdarzenie, akcja = null, sprawdzWarunki = warunkiBezSprawdzacza,
  teraz = () => new Date(), dni = 30 }) {
  const od = new Date(teraz().getTime() - dni * 24 * 3600 * 1000).toISOString();
  const warunki = sprawdzWarunki ?? warunkiBezSprawdzacza;
  const wynik = { od, razem: 0, wykonaloby: 0, pominieteRazem: 0, pominiete: {}, odrzuconeKanalem: {}, przyklady: [] };
  for (const k of zdarzenie.symulacja(db, od, { parametr: regula.zdarzenie_param ?? regula.zdarzenie_json ?? {} })) {
    if (!czyPasujeKanalom(k.sklep, regula.warunki)) {
      wynik.odrzuconeKanalem[k.sklep] = (wynik.odrzuconeKanalem[k.sklep] ?? 0) + 1;
      continue;
    }
    wynik.razem += 1;
    const wykonanie = { id: null, regula_id: regula.id ?? null, zamowienie_id: k.zamowienie_id, przesylka_id: k.przesylka_id ?? null,
      zdarzenie_at: k.zdarzenie_at, proby: 0 };
    const glowne = db.prepare('SELECT scalone_do FROM zamowienia WHERE id = ?').get(k.zamowienie_id)?.scalone_do;
    let odmowa = glowne ? { ok: false, kod: 'dolaczone', powod: `dołączone do zamówienia ${glowne} — mail idzie z głównego` }
      : await warunki({ db, regula, wykonanie });
    if (odmowa?.ok && akcja?.zgoda) odmowa = await akcja.zgoda({ db, regula, wykonanie });
    if (odmowa?.ok) wynik.wykonaloby += 1;
    else {
      const kod = odmowa?.kod ?? 'warunek';
      wynik.pominieteRazem += 1;
      wynik.pominiete[kod] = (wynik.pominiete[kod] ?? 0) + 1;
    }
    if (wynik.przyklady.length < 5) {
      wynik.przyklady.push({ zamowienie_id: k.zamowienie_id, zdarzenie_at: k.zdarzenie_at, ok: Boolean(odmowa?.ok),
        powod: odmowa?.ok ? null : odmowa?.powod ?? null, adresat: odmowa?.ok ? odmowa.adresat ?? null : null });
    }
  }
  return wynik;
}
