// PRZ-108.08 (zmiana C1 planu automatyzacji, właściciel 21.10): warunki reguły sprawdzane W CHWILI WYKONANIA (po opóźnieniu,
// tuż przed rezerwacją), nie przy wykryciu zdarzenia. Kanał sprawdza detektor (kanał zamówienia się nie zmienia);
// tu są warunki, które mogą się zmienić w oknie opóźnienia: status, paczka z numerem listu, sposób dostawy, pobranie.
//
// Czysta funkcja: zamówienie w kształcie `pobierzZamowienie` (z `przesylki`, `statusy_wlasne`, `status_wlasny`) i warunki
// reguły → `{ ok: true }` albo `{ ok: false, kod: 'warunek', powod }`. Każda reguła pyta TĘ SAMĄ funkcję, którą pyta
// reszta panelu — status z `wyliczStatus` (ten sam, co na liście zamówień), paczki z `paczkiDoMaila` (ta sama reguła,
// co mail „Zamówienie wysłane”), dostawa z `metodaWysylki` i pobranie z `czyPobranie` (oba z ręczną zmianą na karcie).
// Druga kopia którejkolwiek reguły znaczyłaby automat, który widzi inny status niż człowiek na liście.
import { wyliczStatus, ETYKIETY } from './status.js';
import { paczkiDoMaila } from './wiadomosc-wyslane.js';
import { metodaWysylki, czyPobranie, ETYKIETY_WYSYLKI } from './wysylka.js';
import { numerZAllegro } from './przesylka-stan.js';

export const POBRANIE = Object.freeze(['dowolne', 'tak', 'nie']);
export const ZAMOWIENIE_STARSZE_NIZ_DNI = 14;
// PRZ-110.02: potwierdzenie przyjęcia po wielodniowej przerwie w synchronizacji myli kupującego.
// Próg względem chwili zdarzenia, nie włączenia reguły ani terminu wysyłki — celowe opóźnienie reguły go nie wydłuża.
export const IMPORT_SPOZNIONY_H = 48;

const ok = Object.freeze({ ok: true });
const nie = (powod) => ({ ok: false, kod: 'warunek', powod });
const lista = (w) => (Array.isArray(w) ? w : []);

/** Etykieta statusu: z Ustawień (zamówienie niesie `etykiety_statusow`), potem wbudowana, na końcu klucz. */
function etykietaStatusu(klucz, z, etykiety = {}) {
  return etykiety[klucz] ?? z?.etykiety_statusow?.[klucz] ?? ETYKIETY[klucz] ?? klucz;
}
const wyliczenie = (nazwy) => (nazwy.length === 1 ? nazwy[0] : `${nazwy.slice(0, -1).join(', ')} albo ${nazwy.at(-1)}`);

/**
 * @param {any} z zamówienie (`pobierzZamowienie`)
 * @param {{ statusy?: string[], maNumerListu?: boolean, metody?: string[], pobranie?: string }} warunki
 * @param {{ etykiety?: Record<string, string> }} [opcje] etykiety statusów z Ustawień (do zdania w dzienniku)
 */
export function sprawdzWarunki(z, warunki = {}, { etykiety = {} } = {}) {
  if (!z) return nie('Zamówienia już nie ma w OMS-ie.');
  const w = warunki ?? {};

  // Pusty zestaw = „dowolny status”.
  const statusy = lista(w.statusy);
  if (statusy.length) {
    const teraz = wyliczStatus(z);
    if (!statusy.includes(teraz)) {
      const oczekiwane = wyliczenie(statusy.map((s) => etykietaStatusu(s, z, etykiety)));
      return nie(`Status jest teraz ${etykietaStatusu(teraz, z, etykiety)} — warunek „status jest ${oczekiwane}” `
        + 'przestał być spełniony. Jeśli zamówienie znów dostanie ten status, reguła sprawdzi je od nowa.');
    }
  }

  if (w.maNumerListu === true && !paczkiDoMaila(z).length) {
    return nie('Zamówienie nie ma paczki z numerem listu (paczki z błędem i „do wyjaśnienia” się nie liczą).');
  }

  const metody = lista(w.metody);
  if (metody.length) {
    const metoda = metodaWysylki(z);
    if (!metody.includes(metoda)) {
      return nie(`Sposób dostawy to ${ETYKIETY_WYSYLKI[metoda] ?? metoda ?? 'nieznany'} — reguła obejmuje tylko: `
        + `${metody.map((m) => ETYKIETY_WYSYLKI[m] ?? m).join(', ')}.`);
    }
  }

  if (w.pobranie === 'tak' && !czyPobranie(z)) return nie('Zamówienie nie jest za pobraniem — reguła obejmuje tylko pobrania.');
  if (w.pobranie === 'nie' && czyPobranie(z)) return nie('Zamówienie jest za pobraniem — reguła obejmuje tylko zamówienia bez pobrania.');

  return ok;
}

const DZIEN_MS = 24 * 3600 * 1000;
const dataPl = (ms) => new Date(ms).toISOString().slice(0, 10).split('-').reverse().join('.');

/** Warunek tylko dla „Nowe zamówienie”: spóźniony import zostaje w dzienniku, bez automatycznego potwierdzenia. */
export function importSpozniony(z, wykonanie) {
  const zlozone = Date.parse(z?.utworzone_at ?? '');
  const wykryte = Date.parse(wykonanie?.zdarzenie_at ?? '');
  if (Number.isNaN(zlozone) || Number.isNaN(wykryte) || wykryte - zlozone <= IMPORT_SPOZNIONY_H * 3600_000) return ok;
  return { ok: false, kod: 'spozniony_import', powod: `Zamówienie złożone ${dataPl(zlozone)} — wykryte przez OMS po ponad `
    + `${IMPORT_SPOZNIONY_H} godzinach. Potwierdzenie nie idzie automatem; w razie potrzeby wyślij je ręcznie z karty.` };
}

/**
 * PRZ-108.08 (poprawki po recenzji 08, usterki 1 i 3): „mail do historii” — zamówienie, które wysłano albo złożono
 * przed włączeniem reguły, nie dostaje maila, choćby zdarzenie przyszło po włączeniu. Dwie drogi, którymi to się działo:
 *  • cofnięcie i ponowne „Wysłane” na starym zamówieniu (nowa data `wyslane_at`) — rozpoznajemy po paczce z numerem
 *    listu sprzed granicy (`p.id ≤ granica.przesylki`). Samo „Wysłane” bez paczki nie zostawia śladu po cofnięciu
 *    (`wyslane_at` się zeruje), więc tę lukę domyka druga reguła:
 *  • numer dociągnięty z Allegro przy otwarciu karty starego zamówienia (nowa paczka z dzisiejszą datą) albo import
 *    starego zamówienia — rozpoznajemy po dacie złożenia (`utworzone_at`) wcześniejszej niż granica − 14 dni.
 * Dlaczego 14 dni: zamówienie złożone ponad dwa tygodnie przed włączeniem, a „wysłane” po nim, to w zdecydowanej
 * większości stare zamówienie poprawiane albo dociągane z Allegro, nie świeża wysyłka. Strata działa raz, przy
 * włączeniu: wolne zamówienia (np. indywidualne w produkcji) złożone ponad 14 dni przed włączeniem nie dostaną maila
 * automatycznie — operator wyśle go z karty. Brak maila, nigdy mail za dużo.
 * Bez granicy (podgląd „30 dni” nowej reguły) → spełnione.
 */
export function historiaPrzedGranica(z, granica, { dni = ZAMOWIENIE_STARSZE_NIZ_DNI, wykonanie = null } = {}) {
  if (!z) return ok;
  const granicaMs = Date.parse(granica?.at ?? '');
  // Bez granicy (podgląd „30 dni”) zostaje sama świeżość numeru z Allegro (R2-1); z granicą — najpierw ona.
  if (Number.isNaN(granicaMs)) return numerAllegroPozno(z, wykonanie, dni) ?? ok;
  const migawka = Number(granica.przesylki ?? 0);
  const stara = (z.przesylki ?? []).find((p) => p.status !== 'blad' && String(p.numer_listu ?? '').trim() && Number(p.id) <= migawka);
  if (stara) {
    return { ok: false, kod: 'przed_granica', powod: `Zamówienie wysłane przed włączeniem reguły — ma paczkę z numerem listu sprzed `
      + `włączenia reguły (${String(stara.numer_listu).trim()}). Mail do historii nie idzie; w razie potrzeby wyślij go ręcznie z karty.` };
  }
  const zlozone = Date.parse(z.utworzone_at ?? '');
  if (!Number.isNaN(zlozone) && zlozone < granicaMs - dni * DZIEN_MS) {
    return { ok: false, kod: 'przed_granica', powod: `Zamówienie złożone ${dataPl(zlozone)} — ponad ${dni} dni przed włączeniem reguły `
      + `(${dataPl(granicaMs)}). Mail do historii nie idzie; w razie potrzeby wyślij go ręcznie z karty.` };
  }
  return numerAllegroPozno(z, wykonanie, dni) ?? ok;
}

/**
 * PRZ-108.08b (recenzja 08, runda 2, R2-1): numer listu dociągnięty z Allegro (`zrodlo_numeru = 'allegro'`) przy otwarciu
 * karty to nowa paczka z dzisiejszą datą — także dla zamówienia sprzed tygodni, które Allegro dawno wysłało i doręczyło
 * (scenariusze E i E2: złożone po włączeniu albo < 14 dni przed nim, karta otwarta po 60–90 dniach → „zostało wysłane”).
 * Granica tego nie łapie, bo mierzy wiek zamówienia względem WŁĄCZENIA reguły. Tu świeżość względem ZDARZENIA: paczka
 * wykonania z numerem z Allegro wyzwala tylko, gdy zamówienie złożono nie dawniej niż `dni` (ta sama liczba co próg
 * granicy, ZAMOWIENIE_STARSZE_NIZ_DNI) przed `zdarzenie_at`. Paczki z panelu i z ręcznej rejestracji (`reka`) — bez zmian.
 * Bez paczki w wykonaniu (zdarzenie statusu) albo bez daty złożenia → spełnione.
 */
function numerAllegroPozno(z, wykonanie, dni) {
  if (wykonanie?.przesylka_id == null) return null;
  const p = (z.przesylki ?? []).find((x) => Number(x.id) === Number(wykonanie.przesylka_id));
  if (!p || !numerZAllegro(p)) return null;
  const zlozone = Date.parse(z.utworzone_at ?? '');
  const zdarzenie = Date.parse(wykonanie.zdarzenie_at ?? '');
  if (Number.isNaN(zlozone) || Number.isNaN(zdarzenie) || zlozone >= zdarzenie - dni * DZIEN_MS) return null;
  return { ok: false, kod: 'numer_allegro_pozno', powod: `Numer listu dociągnięty z Allegro (${String(p.numer_listu ?? '').trim()}) `
    + `${dataPl(zdarzenie)}, ponad ${dni} dni po złożeniu zamówienia (${dataPl(zlozone)}) — przesyłka mogła dawno dojść. `
    + 'Mail nie idzie; w razie potrzeby wyślij go ręcznie z karty.' };
}

/** Opis warunków dla człowieka (ekran reguły): „jest Wysłane i ma paczkę z numerem listu”. Pusty tekst = brak warunków. */
export function opisWarunkow(warunki = {}, { etykiety = {} } = {}) {
  const w = warunki ?? {};
  const czesci = [];
  const statusy = lista(w.statusy);
  if (statusy.length) czesci.push(`ma status ${wyliczenie(statusy.map((s) => etykiety[s] ?? ETYKIETY[s] ?? s))}`);
  if (w.maNumerListu === true) czesci.push('ma paczkę z numerem listu');
  const metody = lista(w.metody);
  if (metody.length) czesci.push(`jedzie: ${metody.map((m) => ETYKIETY_WYSYLKI[m] ?? m).join(', ')}`);
  if (w.pobranie === 'tak') czesci.push('jest za pobraniem');
  if (w.pobranie === 'nie') czesci.push('nie jest za pobraniem');
  return czesci.length > 1 ? `${czesci.slice(0, -1).join(', ')} i ${czesci.at(-1)}` : czesci[0] ?? '';
}
