import { parsujPaczkeInpost } from './paczka.js';
import { profilGabarytuAllegro, parsujGabarytAllegro } from './gabaryty-allegro.js';
import { METODY_WZA } from './allegro-wysylka.js';
import { odczytajSzablony } from './szablony-paczek.js';

// PRZ-152.G11: domyślny gabaryt i waga dla paczkomatu InPost i automatów przez Allegro.
//
// JEDNO MIEJSCE dla karty nadania i nadania hurtem — `propozycjaAutomatu`. To tylko wartość
// STARTOWA formularza: walidacja przy nadaniu zostaje w `parsujPaczkeInpost`/`parsujGabarytAllegro`,
// a wybór człowieka na ekranie wygrywa.
//
// ⚠️ BRAK USTAWIENIA = DZISIEJSZE ZACHOWANIE, żeby po wydaniu nic się samo nie zmieniło:
// paczkomat A + waga domyślnego szablonu kuriera, automat Allegro S + 1 kg (jak One Box
// w gabaryty-allegro.js). Po pierwszym zapisie waga paczkomatu nie zależy już od szablonu.
//
// Zapis: jeden klucz tekstowy (JSON) w tabeli `ustawienia`, jak `paczka.szablony` — bez migracji.

const KLUCZ = 'paczka.automaty';
const INPOST_DOMYSLNY_GABARYT = 'A';
const ALLEGRO_DOMYSLNY_GABARYT = 'S';
const ALLEGRO_DOMYSLNA_WAGA = 1;

/** Usługi Allegro z profilem gabarytu S/M/L — nazwa z METODY_WZA, długość z profilu. */
export const USLUGI_AUTOMATOW = Object.freeze(Object.entries(METODY_WZA)
  .filter(([id]) => profilGabarytuAllegro(id))
  .map(([id, { nazwa }]) => Object.freeze({ id, nazwa, dlugosc: profilGabarytuAllegro(id).dlugosc })));

const usluga = (id) => USLUGI_AUTOMATOW.find((u) => u.id === id) ?? null;

// Walidacja TYMI SAMYMI parserami, co przy nadaniu — ustawienie, którego parser by odmówił,
// kazałoby człowiekowi poprawiać każdy formularz.
function sprawdzInpost(dane) {
  const { paczka, blad } = parsujPaczkeInpost({ gabaryt: dane?.gabaryt, waga: dane?.waga });
  return blad ? { blad } : { wartosc: { gabaryt: paczka.gabaryt, waga: paczka.waga } };
}

function sprawdzAllegro(dane, deliveryMethodId) {
  const gabaryt = String(dane?.gabaryt ?? '').trim().toUpperCase();
  const { paczka, blad } = parsujGabarytAllegro({ gabaryt, waga: dane?.waga }, deliveryMethodId);
  return blad ? { blad } : { wartosc: { gabaryt: paczka.gabaryt, waga: paczka.waga } };
}

const pustyStan = () => ({ inpost: null, allegro: null, wyjatki: {} });

/** Brak albo uszkodzenie zapisu = brak ustawienia (dzisiejsze zachowanie); zła część znika sama. */
export function odczytajAutomaty(zapis = {}) {
  const stan = pustyStan();
  let surowy;
  try { surowy = JSON.parse(zapis[KLUCZ]); } catch { return stan; }
  if (surowy?.version !== 1) return stan;
  if (surowy.inpost) stan.inpost = sprawdzInpost(surowy.inpost).wartosc ?? null;
  if (surowy.allegro) stan.allegro = sprawdzAllegro(surowy.allegro, USLUGI_AUTOMATOW[0].id).wartosc ?? null;
  for (const [id, dane] of Object.entries(surowy.wyjatki ?? {})) {
    if (!usluga(id)) continue;
    const { wartosc } = sprawdzAllegro(dane, id);
    if (wartosc) stan.wyjatki[id] = wartosc;
  }
  return stan;
}

export function zapiszAutomaty(stan) {
  return { [KLUCZ]: JSON.stringify({ version: 1, inpost: stan.inpost, allegro: stan.allegro, wyjatki: stan.wyjatki }) };
}

/**
 * Zapis jednego wiersza ekranu: `cel` = 'paczkomat' (InPost), 'allegro' (wszystkie usługi) albo
 * identyfikator usługi Allegro (wyjątek). Zwraca `{ stan, bledy: [] }` albo `{ bledy }`.
 */
export function zmienAutomat(stan, { cel, gabaryt, waga } = {}) {
  let wynik;
  if (cel === 'paczkomat') wynik = sprawdzInpost({ gabaryt, waga });
  else if (cel === 'allegro') wynik = sprawdzAllegro({ gabaryt, waga }, USLUGI_AUTOMATOW[0].id);
  else if (usluga(cel)) wynik = sprawdzAllegro({ gabaryt, waga }, cel);
  else return { bledy: ['Nie ma takiej usługi paczkomatu ani automatu.'] };
  if (wynik.blad) return { bledy: [wynik.blad] };
  if (cel === 'paczkomat') return { stan: { ...stan, inpost: wynik.wartosc }, bledy: [] };
  if (cel === 'allegro') return { stan: { ...stan, allegro: wynik.wartosc }, bledy: [] };
  return { stan: { ...stan, wyjatki: { ...stan.wyjatki, [cel]: wynik.wartosc } }, bledy: [] };
}

/** „Jak wszystkie” — usługa wraca do wspólnego ustawienia automatów. */
export function usunWyjatekAutomatu(stan, id) {
  if (!Object.hasOwn(stan.wyjatki, id)) return { bledy: ['Ta usługa nie ma własnego ustawienia.'] };
  const wyjatki = { ...stan.wyjatki };
  delete wyjatki[id];
  return { stan: { ...stan, wyjatki }, bledy: [] };
}

/** Dzisiejsze wartości startowe, gdy nic nie zapisano — także do pokazania na ekranie ustawień. */
export function domyslneAutomaty(zapis = {}) {
  const szablony = odczytajSzablony(zapis);
  const kurier = szablony.szablony.find((s) => s.id === szablony.domyslnyId);
  return {
    inpost: { gabaryt: INPOST_DOMYSLNY_GABARYT, waga: kurier.waga },
    allegro: { gabaryt: ALLEGRO_DOMYSLNY_GABARYT, waga: ALLEGRO_DOMYSLNA_WAGA },
  };
}

/**
 * Propozycja `{ gabaryt, waga }` do formularza nadania (karta i hurt).
 * `rodzaj`: 'paczkomat' (InPost) albo 'wza' (Wysyłam z Allegro; tylko usługa z profilem gabarytu).
 * Inny rodzaj albo usługa bez profilu → `null` (formularz kuriera, szablony paczek).
 * Kolejność dla automatu: wyjątek usługi > „wszystkie” > dzisiejsze S + 1 kg.
 */
export function propozycjaAutomatu(zapis = {}, { rodzaj, deliveryMethodId = null } = {}) {
  const stan = odczytajAutomaty(zapis);
  if (rodzaj === 'paczkomat') return { ...(stan.inpost ?? domyslneAutomaty(zapis).inpost) };
  if (rodzaj !== 'wza' || !usluga(deliveryMethodId)) return null;
  return { ...(stan.wyjatki[deliveryMethodId] ?? stan.allegro ?? domyslneAutomaty(zapis).allegro) };
}
