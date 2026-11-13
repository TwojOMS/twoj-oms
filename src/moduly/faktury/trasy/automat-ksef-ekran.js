// PRZ-108.06 (zmiana A planu automatyzacji, właściciel 21.10): formularz automatu wysyłki do KSeF przeniesiony z ekranu
// Ustawienia → Integracje → inFakt na Ustawienia → Automatyzacje. JEDNO źródło dla obu adresów zapisu:
//  • nowy `POST /ustawienia/automatyzacje/ksef` (moduł automatyzacje, trasy/ekran.js),
//  • stary `POST /ustawienia/integracje/infakt/ksef-automat` (trasy/ustawienia-infakt.js) — zakładki i formularze
//    otwarte przed wydaniem dalej zapisują, a wracają na nowy ekran.
// Logika automatu bez zmian: walidacja i „ostatni przebieg po zapisie” z domena/ksef-automat.js, zapis z db/ksef-automat.js
// (wyjęte 1:1 z ustawienia-infakt.js z PRZ-102.12). Zmienia się tylko, KTO zapisuje: wyłącznie admin (decyzja właściciela
// 21.10) — dawniej każde konto z uprawnieniem „ustawienia”.
import {
  sprawdzFormularzAutomatu, ostatniPrzebiegPoZapisie, najblizszyPrzebieg, chwilaWarszawy, sprawdzFormularzTrybu,
  CO_ILE_PO_WYSTAWIENIU_MIN, ODSTEP_EDYCJI_MAKS,
} from '../../../domena/ksef-automat.js';
import { ustawieniaFormulki } from '../../../domena/ustawienia-formulki.js';
import { wczytajUstawienia } from '../../../oms/db/ustawienia.js';
import { wczytajAutomatKsef, zapiszUstawieniaAutomatu, zapiszTrybAutomatu, czyDoZwolnienia } from '../db/ksef-automat.js';
import { czyWysylacKonsumenckie, KONSUMENCKIE_POZA_KSEF_TF } from '../db/ksef-konsumenckie.js';
import { nawigacjaUstawien } from '../../ustawienia/nawigacja.js';
import { odmianaNazwyProgramu, gdzieDokument } from '../../../domena/nazwa-programu.js';
import { zdanieBrakuProgramu, jawnyBrak, EKRAN_WYBORU_PROGRAMU } from '../../../domena/wybor-programu.js';

export const EKRAN_AUTOMATYZACJI = '/ustawienia/automatyzacje';
export const ZAPIS_AUTOMATU_KSEF = `${EKRAN_AUTOMATYZACJI}/ksef`;
const PO_ZAPISIE = `${EKRAN_AUTOMATYZACJI}/systemowe?zapisano=ksef-automat#ksef-automat`;
// PRZ-119.07: adres automatu pod programem fakturowym (dowolny program, nie tylko inFakt). Stary adres ekranu inFaktu
// przekierowuje tu GET-em 301; jego POST zostaje aliasem zapisu (ustawienia-infakt.js).
export const AUTOMAT_KSEF_PROGRAMU = `${EKRAN_WYBORU_PROGRAMU}/ksef-automat`;
// ⚠️ Nie `ustawienia-automatyzacje.ejs` — ta nazwa należy do autorespondera (wiadomosci/widoki), a widoki modułów
// mają jedną płaską przestrzeń nazw (tests/core/widoki-unikalne.test.js).
const WIDOK = 'automatyzacje.ejs';
const KOMUNIKATY = { 'ksef-automat': 'Zapisano ustawienia automatycznej wysyłki do KSeF.' };

// PRZ-102.12: dlaczego automat KSeF nic nie wyśle — jedno zdanie na ekran albo `null`, gdy działa.
// PRZ-118.09: `nazwa` = odmiana nazwy programu (bez programu — inFakt, jak przed zmianą).
function powodBezczynnosciAutomatu(k, automatKsef, nazwa) {
  // PRZ-121.03a: jawny „brak” (plik albo Ustawienia) — automat stoi z powodu wyboru, nie braku klucza. `teraz()` widzi
  // też „brak” zapisany po starcie (automat staje od razu); bez wyboru zdanie jest `null` i idą stare teksty.
  const brak = zdanieBrakuProgramu(k.wyborProgramu?.teraz?.() ?? k.wyborProgramu, 'Automatyczna wysyłka do KSeF nic nie wyśle.');
  if (brak) return brak;
  if (automatKsef && !k.odlaczonyDoRestartu()) return null;
  // PRZ-119.07: Fakturownia — rodzaj żeński („odłączona”, „jej”); inFakt i reszta jak przed zmianą.
  const [y, go] = k.zenska === true ? ['a', 'jej'] : ['y', 'go'];
  if (k.odlaczonyDoRestartu()) return `${nazwa.mianownik} jest odłączon${y} — automat nic nie wyśle, dopóki ${go} nie podłączysz i nie uruchomisz OMS-u ponownie.`;
  if (k.wymagaRestartu()) return `${nazwa.mianownik} jest już podłączon${y}, ale automat ruszy dopiero po ponownym uruchomieniu OMS-u.`;
  return `${nazwa.mianownik} nie jest podłączon${y} — automat nic nie wyśle, dopóki ${go} nie podłączysz (potem potrzebne ponowne uruchomienie OMS-u).`;
}

/** PRZ-123 C09: tryby wysyłki tylko przy programie z własną wysyłką do KSeF (TwojeFaktury); inFakt — bez zmian. */
const maWyborTrybu = (program) => program?.opis?.wbudowany === true;

/** Stan automatu do kafla „Automatyczna wysyłka do KSeF” na ekranie inFaktu: włączony? najbliższy przebieg. */
export function stanAutomatuKsef(db, teraz = () => new Date()) {
  const stan = wczytajAutomatKsef(db);
  return { wlaczony: stan.wlaczony, najblizszy: najblizszyPrzebieg(stan, chwilaWarszawy(teraz())) };
}

/** Model sekcji `#ksef-automat` (partial faktury/widoki/_automat-ksef.ejs). */
// PRZ-119.07: `konfiguracjaProgramu` = stan wybranego programu (inFakt albo Fakturownia); `konfiguracjaInfaktu` zostaje
// jako stara nazwa tej samej zależności (testy i wołający sprzed zmiany).
export function modelAutomatuKsef({ db, konfiguracjaProgramu, konfiguracjaInfaktu, automatKsef = null, teraz = () => new Date(), infakt: program = null },
  { bledy = [], formularz = null } = {}) {
  const k = konfiguracjaProgramu ?? konfiguracjaInfaktu;
  const stan = wczytajAutomatKsef(db);
  // PRZ-118.09: usługa `infakt` modułu faktur (klient albo program) — nazwa w zdaniach sekcji automatu.
  // PRZ-119.07: bez programu (niepodłączony) nazwa z konfiguracji wybranego programu, a bez niej — inFakt jak dotąd.
  const nazwaProgramu = program ? odmianaNazwyProgramu(program) : (k?.nazwa ?? odmianaNazwyProgramu(null));
  // PRZ-123 C09: program z własną wysyłką (TwojeFaktury) — wybór trybu i odstępu na poprawki zamiast przełącznika.
  const wyborTrybu = maWyborTrybu(program);
  return {
    nazwaProgramu, gdzieProgramu: gdzieDokument(program),
    ...stan,
    // PRZ-123 C09cb: „albo zwolnij” w pasku tylko, gdy choć jeden wpis da się zwolnić (odrzuconej / niewysłanej nie).
    zwolnienieMozliwe: (stan.wstrzymane ?? []).some(czyDoZwolnienia),
    wyborTrybu, coIleMin: CO_ILE_PO_WYSTAWIENIU_MIN, odstepMaks: ODSTEP_EDYCJI_MAKS,
    // Po błędzie formularza pola pokazują to, co wpisał człowiek, a nie zapis z bazy.
    formularz: formularz ?? { wlaczony: stan.wlaczony, godzina: stan.godzina, tryb: stan.tryb, odstepEdycji: stan.odstepEdycji },
    bledy,
    najblizszy: wyborTrybu && stan.tryb === 'po_wystawieniu' ? `co ${CO_ILE_PO_WYSTAWIENIU_MIN} minut`
      : najblizszyPrzebieg(wyborTrybu ? { ...stan, wlaczony: stan.tryb === 'o_godzinie' } : stan, chwilaWarszawy(teraz())),
    powodBezczynnosci: powodBezczynnosciAutomatu(k, automatKsef, nazwaProgramu),
    // PRZ-121.03b: jawny „brak” (też zapisany po starcie) — linia stanu nie mówi „Włączony — najbliższy przebieg”.
    stoiPrzezBrak: jawnyBrak(k?.wyborProgramu?.teraz?.() ?? k?.wyborProgramu),
    // PRZ-122.B2C-QR: TwojeFaktury wydaje PDF konsumenckiej dopiero z numerem KSeF — przy wyłączonym przełączniku
    // „konsumenckie w KSeF” jedno zdanie ostrzeżenia (to samo, co w odmowie pobrania PDF). inFakt — bez zdania.
    // PRZ-126.J01: wersja TF — przełącznik przy TwojeFaktury stoi na ekranie Wysyłka do KSeF.
    ostrzezenieKonsumenckie: wyborTrybu && !czyWysylacKonsumenckie(db)
      ? `${KONSUMENCKIE_POZA_KSEF_TF.charAt(0).toUpperCase()}${KONSUMENCKIE_POZA_KSEF_TF.slice(1)}.` : null,
  };
}

// Wzór: ustawienia/trasy/konta.js — gość demo publicznego ogląda (GET), zapis blokuje mu już hak podglądu.
export function tylkoAdmin(req, reply) {
  if (req.konto?.admin) return null;
  if (req.konto?.podgladDemo && req.method === 'GET') return null;
  return reply.code(403).view('brak-dostepu.ejs', { title: 'Brak dostępu', wlasnyUklad: true });
}

// PRZ-108.08: model sekcji reguł dokłada moduł automatyzacji, który buduje się PO module faktur (stary adres zapisu na
// ekranie inFaktu rejestruje się wcześniej i go nie zna). Moduł automatyzacji zgłasza swój model tutaj, per baza — bez
// stanu globalnego między aplikacjami (każdy test i każdy proces ma własną bazę).
const dodatkiEkranu = new WeakMap();
export function zglosDodatkiEkranuAutomatyzacji(db, dodatki) { dodatkiEkranu.set(db, dodatki); }

/** Ekran Ustawienia → Automatyzacje (GET i odpowiedź 400 obu adresów zapisu). */
export function widokEkranuAutomatyzacji(req, reply, zaleznosci, { bledy = [], formularz = null } = {}) {
  const { db } = zaleznosci;
  const dodatki = zaleznosci.dodatki ?? dodatkiEkranu.get(db);
  return reply.view(WIDOK, {
    nawigacja: nawigacjaUstawien(req, reply), title: 'Automatyzacje',
    tylkoAutomatKsef: zaleznosci.tylkoAutomatKsef === true,
    zapisano: KOMUNIKATY[req.query?.zapisano] ?? null,
    automat: modelAutomatuKsef(zaleznosci, { bledy, formularz }),
    konsumenckie: czyWysylacKonsumenckie(db),
    autoodpowiedz: { wlaczona: ustawieniaFormulki(wczytajUstawienia(db)).wlaczona },
    // PRZ-108.07: sekcję reguł dokłada moduł automatyzacji (model listy reguł); PRZ-108.08: także dla starego adresu
    // zapisu na ekranie inFaktu (zgłoszenie per baza, wyżej). Skład bez modułu automatyzacji — sam opis reguł.
    ...(dodatki?.(req) ?? {}),
  });
}

/** PRZ-119.07: ekran i zapis automatu KSeF pod adresem programu fakturowego (ten sam widok i zapis co Automatyzacje). */
export function registerAdresuAutomatuKsef(app, zaleznosciEkranu) {
  // Ten adres nawigacja przypisuje działowi „Faktury i podatki”, nie zakładce „Automaty systemowe” — flaga każe
  // widokowi i tak pokazać sekcję automatów (GET i odpowiedź 400).
  const zaleznosci = { ...zaleznosciEkranu, tylkoAutomatKsef: true };
  app.get(AUTOMAT_KSEF_PROGRAMU, async (req, reply) => tylkoAdmin(req, reply) ?? widokEkranuAutomatyzacji(req, reply, zaleznosci));
  app.post(AUTOMAT_KSEF_PROGRAMU, obsluzZapisAutomatuKsef(zaleznosci));
}

/** Obsługa zapisu automatu — ta sama dla nowego i starego adresu. */
export function obsluzZapisAutomatuKsef(zaleznosci) {
  const { db, teraz = () => new Date() } = zaleznosci;
  // PRZ-123 C09: tryb i odstęp (TwojeFaktury). „O godzinie” jak inFakt: włączenie po dzisiejszej godzinie — pierwszy
  // przebieg jutro. Każda zmiana zostawia wpis w logu z kontem (decyzja kierownika C09).
  const zapiszTryb = (req, reply) => {
    const formularz = sprawdzFormularzTrybu(req.body ?? {});
    if (formularz.bledy.length) {
      reply.code(400);
      return widokEkranuAutomatyzacji(req, reply, zaleznosci, { bledy: formularz.bledy, formularz });
    }
    const chwila = teraz();
    const poprzednio = wczytajAutomatKsef(db);
    const login = req.konto?.login ?? null;
    zapiszTrybAutomatu(db, {
      tryb: formularz.tryb, odstepEdycji: formularz.odstepEdycji, godzina: formularz.godzina, login,
      ostatniPrzebieg: ostatniPrzebiegPoZapisie({ ...poprzednio, wlaczony: poprzednio.tryb === 'o_godzinie' },
        { wlaczony: formularz.tryb === 'o_godzinie', godzina: formularz.godzina }, chwilaWarszawy(chwila)),
    }, chwila.toISOString());
    req.log?.info?.({
      konto: login, tryb: formularz.tryb, odstepEdycji: formularz.odstepEdycji, godzina: formularz.godzina,
      poprzednio: { tryb: poprzednio.tryb, odstepEdycji: poprzednio.odstepEdycji, godzina: poprzednio.godzina },
    }, 'Automat KSeF: zmiana trybu wysyłki');
    return reply.code(303).redirect(PO_ZAPISIE);
  };
  return async (req, reply) => {
    const odmowa = tylkoAdmin(req, reply);
    if (odmowa) return odmowa;
    if (modelAutomatuKsef(zaleznosci).wyborTrybu) return zapiszTryb(req, reply); // ten sam wybór co ekran
    const formularz = sprawdzFormularzAutomatu(req.body ?? {});
    if (formularz.bledy.length) {
      reply.code(400);
      return widokEkranuAutomatyzacji(req, reply, zaleznosci, { bledy: formularz.bledy, formularz });
    }
    const chwila = teraz();
    const poprzednio = wczytajAutomatKsef(db);
    const nowe = { wlaczony: formularz.wlaczony, godzina: formularz.godzina };
    zapiszUstawieniaAutomatu(db, {
      ...nowe, login: req.konto?.login ?? null,
      ostatniPrzebieg: ostatniPrzebiegPoZapisie(poprzednio, nowe, chwilaWarszawy(chwila)),
    }, chwila.toISOString());
    return reply.code(303).redirect(PO_ZAPISIE);
  };
}
