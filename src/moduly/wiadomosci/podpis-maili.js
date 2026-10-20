// PRZ-102.10: podpis maili do klientów (marka i stopka) z Ustawień → Integracje → Poczta wychodząca.
//
// Dwa wiersze tabeli `ustawienia` (klucz → wartość, bez migracji; wzór oms/db/moduly-opcjonalne.js).
// **Plik wygrywa** (zasada PRZ-092), osobno dla każdego pola: niepuste OMS_MAIL_MARKA albo OMS_MAIL_STOPKA w pliku
// konfiguracji blokuje zapis tego pola w panelu, a mail bierze wartość z pliku. Puste w pliku = jak brak — ta sama
// reguła, która od PRZ-029 daje bajtowo ten sam mail przy pustej zmiennej i bez niej (oprawa-pusta-konfiguracja).
// Zapis z panelu działa od następnego maila: usługi wołają `podpisZPanelu` przy każdym złożeniu, nie raz przy starcie.
import { oprawaMaila, tekstZeStopka } from './oprawa.js';
import { renderSzablonHtml, podpisHtml } from '../../core/poczta/szablon-html.js';
import { zlozTresc, liniePodpisu } from '../../domena/szablony-wiadomosci.js';
import { zdaniaDoMaila } from '../../domena/zdania-platnosci.js';
// Import w kółko z ./zdania-platnosci.js (ten bierze stąd ZAKAZANE) — bezpieczny: oba używają importu dopiero w funkcjach.
import { zdaniaPlatnosciTeraz } from './zdania-platnosci.js';

export const KLUCZE_PODPISU = Object.freeze({ marka: 'poczta.podpis.marka', stopka: 'poczta.podpis.stopka' });
export const MAKS_PODPISU = Object.freeze({ marka: 120, stopka: 600, linieStopki: 8 });

// Znaki sterujące (C0, DEL, C1), separatory linii Unicode i znaki zmiany kierunku tekstu (podszywanie się pod
// inną treść w nagłówku maila). Stopka dopuszcza wyłącznie nową linię. To samo wyrażenie sprawdza zdania o płatności
// (PRZ-102.17, zdania-platnosci.js) — jedna lista zakazanych znaków dla wszystkiego, co operator wpisuje do maila.
export const ZAKAZANE = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;

/**
 * Które pola ustawia plik konfiguracji. Liczone z oprawy złożonej z pliku (wiadomosci/konfiguracja.ts): niepuste
 * OMS_MAIL_MARKA daje niepusty nagłówek, niepuste OMS_MAIL_STOPKA — niepustą stopkę. Bez nowego odczytu env.
 */
export function podpisZPliku(oprawaPoczty) {
  return { marka: Boolean(oprawaPoczty?.naglowek), stopka: Boolean(oprawaPoczty?.footer) };
}

/** Zapis z panelu: `{ marka, stopka, zmienioneAt }`; brak wiersza = `null`. */
export function wczytajPodpisMaili(db) {
  const wiersze = db.prepare('SELECT klucz, wartosc, zmienione_at FROM ustawienia WHERE klucz IN (?, ?)')
    .all(KLUCZE_PODPISU.marka, KLUCZE_PODPISU.stopka);
  const w = Object.fromEntries(wiersze.map((r) => [r.klucz, r]));
  const daty = wiersze.map((r) => r.zmienione_at).sort();
  return {
    marka: w[KLUCZE_PODPISU.marka]?.wartosc ?? null,
    stopka: w[KLUCZE_PODPISU.stopka]?.wartosc ?? null,
    zmienioneAt: daty.at(-1) ?? null,
  };
}

/**
 * Pola, którymi panel nadpisuje oprawę z pliku: tylko zapisane i niezablokowane plikiem.
 * `zPliku` bez wartości (stary skład usług) = nic nie jest zablokowane.
 */
export function podpisZPanelu(db, zPliku = {}) {
  const zapis = wczytajPodpisMaili(db);
  const wynik = {};
  if (!zPliku.marka && zapis.marka) wynik.marka = zapis.marka;
  if (!zPliku.stopka && zapis.stopka) wynik.stopka = zapis.stopka;
  return wynik;
}

/** Oprawa z pliku z nałożonym podpisem z panelu — wejście `oprawaMaila`. Bez nadpisania: oprawa z pliku bez zmian. */
export function nalozPodpis(oprawaPoczty, nadpisanie) {
  const baza = oprawaPoczty ?? {};
  if (!nadpisanie || (!nadpisanie.marka && !nadpisanie.stopka)) return baza;
  return {
    ...baza,
    ...(nadpisanie.marka ? { podpis: nadpisanie.marka, naglowek: nadpisanie.marka } : {}),
    ...(nadpisanie.stopka ? { footer: nadpisanie.stopka } : {}),
  };
}

/** Oprawa jednego maila: plik + panel, liczona w chwili wołania. */
export const oprawaTeraz = (oprawaPoczty, podpisPanelu) => () =>
  oprawaMaila(nalozPodpis(oprawaPoczty, podpisPanelu ? podpisPanelu() : null));

/**
 * Walidacja pola formularza. Zwraca `{ wartosc, blad }`; `wartosc` znormalizowana tak samo jak w oprawie
 * (marka: trim; stopka: trim linii, bez pustych), pusty tekst = „wróć do domyślnego”.
 */
export function sprawdzPolePodpisu(pole, surowa) {
  const tekst = String(surowa ?? '').replace(/\r\n?/gu, '\n');
  if (pole === 'marka') {
    const wartosc = tekst.trim();
    if (ZAKAZANE.test(wartosc)) return { wartosc, blad: 'Marka to jedna linia tekstu — bez nowych linii, tabulatorów i znaków sterujących.' };
    if (wartosc.length > MAKS_PODPISU.marka) return { wartosc, blad: `Marka może mieć najwyżej ${MAKS_PODPISU.marka} znaków (wpisano ${wartosc.length}).` };
    return { wartosc, blad: null };
  }
  if (pole === 'stopka') {
    const linie = tekst.split('\n');
    if (linie.some((l) => ZAKAZANE.test(l))) return { wartosc: tekst, blad: 'Stopka może mieć nowe linie, ale bez tabulatorów i innych znaków sterujących.' };
    const wartosc = linie.map((l) => l.trim()).filter(Boolean).join('\n');
    if (wartosc.length > MAKS_PODPISU.stopka) return { wartosc, blad: `Stopka może mieć najwyżej ${MAKS_PODPISU.stopka} znaków (wpisano ${wartosc.length}).` };
    if (wartosc && wartosc.split('\n').length > MAKS_PODPISU.linieStopki) return { wartosc, blad: `Stopka może mieć najwyżej ${MAKS_PODPISU.linieStopki} linii.` };
    return { wartosc, blad: null };
  }
  return { wartosc: '', blad: 'Nieznane pole podpisu.' };
}

/** Zapis jednego pola; pusta wartość usuwa wiersz (mail wraca do domyślnego podpisu albo do maila bez stopki). */
export function zapiszPolePodpisu(db, pole, wartosc, teraz = new Date().toISOString()) {
  const klucz = KLUCZE_PODPISU[pole];
  if (!klucz) throw new Error('Nieznane pole podpisu.');
  if (!wartosc) {
    db.prepare('DELETE FROM ustawienia WHERE klucz = ?').run(klucz);
    return;
  }
  db.prepare(`INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES (?, ?, ?)
    ON CONFLICT(klucz) DO UPDATE SET wartosc = excluded.wartosc, zmienione_at = excluded.zmienione_at`).run(klucz, wartosc, teraz);
}

// Akapit tuż nad {podpis} dostaje w mailu styl zdania zamykającego — jak w prawdziwych wiadomościach.
const PRZYKLAD = ['Dzień dobry,', '', 'tu stoi treść wiadomości — zależy od szablonu (Ustawienia → Szablony wiadomości).', '',
  'W razie pytań wystarczy odpowiedzieć na tę wiadomość.', '', '{podpis}'].join('\n');

/**
 * Podgląd na ekranie Poczty: ten sam renderer co mail ze szablonu (renderSzablonHtml → kopertaMaila), więc marka
 * w nagłówku, podpis i stopka wyglądają jak w prawdziwym mailu, a wartości są escapowane przez renderer.
 */
// PRZ-102.19: `zdania` — „Pozdrawiamy," z Ustawień → Szablony wiadomości (zdaniaPlatnosciTeraz), jak w prawdziwym mailu.
export function podgladPodpisu(oprawa, { zdania = null } = {}) {
  const { pozdrowienie } = zdaniaDoMaila(zdania ?? {});
  const { czesci, tekst } = zlozTresc(PRZYKLAD, { pola: {}, bloki: { podpis: liniePodpisu(oprawa.podpis, pozdrowienie) } });
  return {
    html: renderSzablonHtml(czesci, { podpis: podpisHtml(oprawa.podpis, pozdrowienie) }, oprawa),
    tekst: tekstZeStopka(tekst, oprawa.footer),
  };
}

/**
 * Usługa `wiadomosci.podpisMaili` dla ekranu Ustawienia → Poczta: stan pól (wartość, czy z pliku), oprawa do podglądu
 * i zapis. Zapis pola ustawionego w pliku = 409 (nic nie zapisane), błąd walidacji = 400 (nic nie zapisane).
 */
export function utworzPodpisMaili({ db, oprawaPoczty, teraz = () => new Date() }) {
  const zPliku = podpisZPliku(oprawaPoczty);
  const plik = { marka: oprawaPoczty?.naglowek ?? '', stopka: oprawaPoczty?.footer ?? '' };
  /** Oprawa maila: bieżąca albo — przy podglądzie niezapisanych pól — z wpisanymi wartościami tam, gdzie plik nie blokuje. */
  const oprawa = (wpisane = null) => {
    const nadpisanie = { ...podpisZPanelu(db, zPliku) };
    for (const p of ['marka', 'stopka']) if (wpisane && !zPliku[p] && Object.hasOwn(wpisane, p)) nadpisanie[p] = wpisane[p];
    // Puste pole w podglądzie = oprawa z pliku dla tego pola (domyślny podpis albo brak stopki), jak po zapisie pustego.
    return oprawaMaila(nalozPodpis(oprawaPoczty, nadpisanie));
  };
  return {
    stan() {
      const zapis = wczytajPodpisMaili(db);
      return {
        marka: zPliku.marka ? { wartosc: plik.marka, zPliku: true } : { wartosc: zapis.marka ?? '', zPliku: false },
        stopka: zPliku.stopka ? { wartosc: plik.stopka, zPliku: true } : { wartosc: zapis.stopka ?? '', zPliku: false },
        zmienioneAt: zapis.zmienioneAt,
      };
    },
    oprawa,
    /** Podgląd na ekranie: bieżący podpis albo wpisane (niezapisane) pola; HTML z renderera maila, wartości escapowane. */
    podglad: (wpisane = null) => podgladPodpisu(oprawa(wpisane), { zdania: zdaniaPlatnosciTeraz(db) }),
    /** Walidacja wpisanych pól do podglądu — te same reguły co zapis; pola z pliku pomijane. */
    sprawdz(pola) {
      const wartosci = {}; const bledy = [];
      for (const p of ['marka', 'stopka']) {
        if (zPliku[p] || !Object.hasOwn(pola ?? {}, p)) continue;
        const w = sprawdzPolePodpisu(p, pola[p]);
        wartosci[p] = w.wartosc;
        if (w.blad) bledy.push(w.blad);
      }
      return { wartosci, bledy };
    },
    zapisz(pola) {
      const obecne = ['marka', 'stopka'].filter((p) => Object.hasOwn(pola ?? {}, p));
      if (!obecne.length) return { kod: 400, bledy: ['Formularz nie zawiera marki ani stopki.'] };
      const zablokowane = obecne.filter((p) => zPliku[p]);
      if (zablokowane.length) return { kod: 409, zablokowane };
      const sprawdzone = obecne.map((p) => ({ pole: p, ...sprawdzPolePodpisu(p, pola[p]) }));
      const bledy = sprawdzone.filter((s) => s.blad).map((s) => s.blad);
      if (bledy.length) return { kod: 400, bledy };
      const kiedy = teraz().toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const s of sprawdzone) zapiszPolePodpisu(db, s.pole, s.wartosc, kiedy);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      return { kod: 303 };
    },
  };
}
