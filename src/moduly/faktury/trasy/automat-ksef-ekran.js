// PRZ-108.06 (zmiana A planu automatyzacji, właściciel 21.10): formularz automatu wysyłki do KSeF przeniesiony z ekranu
// Ustawienia → Integracje → inFakt na Ustawienia → Automatyzacje. JEDNO źródło dla obu adresów zapisu:
//  • nowy `POST /ustawienia/automatyzacje/ksef` (moduł automatyzacje, trasy/ekran.js),
//  • stary `POST /ustawienia/integracje/infakt/ksef-automat` (trasy/ustawienia-infakt.js) — zakładki i formularze
//    otwarte przed wydaniem dalej zapisują, a wracają na nowy ekran.
// Logika automatu bez zmian: walidacja i „ostatni przebieg po zapisie” z domena/ksef-automat.js, zapis z db/ksef-automat.js
// (wyjęte 1:1 z ustawienia-infakt.js z PRZ-102.12). Zmienia się tylko, KTO zapisuje: wyłącznie admin (decyzja właściciela
// 21.10) — dawniej każde konto z uprawnieniem „ustawienia”.
import {
  sprawdzFormularzAutomatu, ostatniPrzebiegPoZapisie, najblizszyPrzebieg, chwilaWarszawy,
} from '../../../domena/ksef-automat.js';
import { ustawieniaFormulki } from '../../../domena/ustawienia-formulki.js';
import { wczytajUstawienia } from '../../../oms/db/ustawienia.js';
import { wczytajAutomatKsef, zapiszUstawieniaAutomatu } from '../db/ksef-automat.js';
import { czyWysylacKonsumenckie } from '../db/ksef-konsumenckie.js';
import { nawigacjaUstawien } from '../../ustawienia/nawigacja.js';

export const EKRAN_AUTOMATYZACJI = '/ustawienia/automatyzacje';
export const ZAPIS_AUTOMATU_KSEF = `${EKRAN_AUTOMATYZACJI}/ksef`;
const PO_ZAPISIE = `${EKRAN_AUTOMATYZACJI}?zapisano=ksef-automat#ksef-automat`;
// ⚠️ Nie `ustawienia-automatyzacje.ejs` — ta nazwa należy do autorespondera (wiadomosci/widoki), a widoki modułów
// mają jedną płaską przestrzeń nazw (tests/core/widoki-unikalne.test.js).
const WIDOK = 'automatyzacje.ejs';
const KOMUNIKATY = { 'ksef-automat': 'Zapisano ustawienia automatycznej wysyłki do KSeF.' };

// PRZ-102.12: dlaczego automat KSeF nic nie wyśle — jedno zdanie na ekran albo `null`, gdy działa.
function powodBezczynnosciAutomatu(k, automatKsef) {
  if (automatKsef && !k.odlaczonyDoRestartu()) return null;
  if (k.odlaczonyDoRestartu()) return 'inFakt jest odłączony — automat nic nie wyśle, dopóki go nie podłączysz i nie uruchomisz OMS-u ponownie.';
  if (k.wymagaRestartu()) return 'inFakt jest już podłączony, ale automat ruszy dopiero po ponownym uruchomieniu OMS-u.';
  return 'inFakt nie jest podłączony — automat nic nie wyśle, dopóki go nie podłączysz (potem potrzebne ponowne uruchomienie OMS-u).';
}

/** Stan automatu do kafla „Automatyczna wysyłka do KSeF” na ekranie inFaktu: włączony? najbliższy przebieg. */
export function stanAutomatuKsef(db, teraz = () => new Date()) {
  const stan = wczytajAutomatKsef(db);
  return { wlaczony: stan.wlaczony, najblizszy: najblizszyPrzebieg(stan, chwilaWarszawy(teraz())) };
}

/** Model sekcji `#ksef-automat` (partial faktury/widoki/_automat-ksef.ejs). */
export function modelAutomatuKsef({ db, konfiguracjaInfaktu, automatKsef = null, teraz = () => new Date() },
  { bledy = [], formularz = null } = {}) {
  const stan = wczytajAutomatKsef(db);
  return {
    ...stan,
    // Po błędzie formularza pola pokazują to, co wpisał człowiek, a nie zapis z bazy.
    formularz: formularz ?? { wlaczony: stan.wlaczony, godzina: stan.godzina },
    bledy,
    najblizszy: najblizszyPrzebieg(stan, chwilaWarszawy(teraz())),
    powodBezczynnosci: powodBezczynnosciAutomatu(konfiguracjaInfaktu, automatKsef),
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
    zapisano: KOMUNIKATY[req.query?.zapisano] ?? null,
    automat: modelAutomatuKsef(zaleznosci, { bledy, formularz }),
    konsumenckie: czyWysylacKonsumenckie(db),
    autoodpowiedz: { wlaczona: ustawieniaFormulki(wczytajUstawienia(db)).wlaczona },
    // PRZ-108.07: sekcję reguł dokłada moduł automatyzacji (model listy reguł); PRZ-108.08: także dla starego adresu
    // zapisu na ekranie inFaktu (zgłoszenie per baza, wyżej). Skład bez modułu automatyzacji — sam opis reguł.
    ...(dodatki?.(req) ?? {}),
  });
}

/** Obsługa zapisu automatu — ta sama dla nowego i starego adresu. */
export function obsluzZapisAutomatuKsef(zaleznosci) {
  const { db, teraz = () => new Date() } = zaleznosci;
  return async (req, reply) => {
    const odmowa = tylkoAdmin(req, reply);
    if (odmowa) return odmowa;
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
