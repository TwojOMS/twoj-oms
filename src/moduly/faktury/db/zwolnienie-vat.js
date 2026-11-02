// PRZ-122.B07b: zwolnienie z VAT firmy (Ustawienia → Firma, tylko przy TwojeFaktury). Jeden wiersz tabeli `ustawienia`
// (bez migracji, bez pamięci podręcznej — wzór stawka-vat.js), JSON `{ zwolniona, podstawa, rodzaj }`.
//
// Podstawę składa SERWER z wyboru na ekranie — admin wpisuje tylko numer punktu i literę (art. 43) albo własny tekst
// („inna podstawa”), więc na fakturę nie trafi literówka w „ustawy o VAT”. Dwa przypadki użycia:
//  - firma zwolniona (`zwolniona: true`) → domyślna stawka „zw”, każda faktura z adnotacją (adapter TwojeFaktury);
//  - firma niezwolniona z podstawą (np. art. 43 dla jednej usługi) → pojedyncze pozycje „zw” dostają tę podstawę.
// Bez zapisanej podstawy pozycja „zw” to odmowa wystawienia (adapter, przed rezerwacją numeru).

import { opcjeZwProgramu } from '../../../domena/vat.js';

const KLUCZ = 'vat.zwolnienie';
export const PODSTAWA_ART_113 = 'art. 113 ust. 1 i 9 ustawy o VAT';
export const RODZAJE_ZWOLNIENIA = Object.freeze(['ustawa', 'dyrektywa', 'inna']);
/** FA(3): P_19A/B/C to TZnakowy (do 256 znaków). */
const MAKS_PODSTAWY = 256;
const ART_43 = /^art\. 43 ust\. 1 pkt (\d{1,2})(?: lit\. ([a-z]))? ustawy o VAT$/u;

const tekst = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * Formularz ekranu → zapis. Pola: `zwolniona` ('tak' = zaznaczone), `podstawa` ('' | 'art113' | 'art43' | 'inna'),
 * `punkt` i `litera` (art. 43), `podstawa_tekst` i `rodzaj` („inna”).
 * @returns {{ ustawienia: { zwolniona: boolean, podstawa: string|null, rodzaj: string|null }|null,
 *   bledy: string[], wpisane: Record<string, string|boolean> }}
 */
export function sprawdzFormularzZwolnienia(body = {}) {
  const zwolniona = tekst(body?.zwolniona) === 'tak';
  const wybor = tekst(body?.podstawa);
  const wpisane = {
    zwolniona, podstawa: wybor, punkt: tekst(body?.punkt), litera: tekst(body?.litera),
    podstawa_tekst: tekst(body?.podstawa_tekst).replace(/\s+/gu, ' '), rodzaj: tekst(body?.rodzaj),
  };
  const bledy = [];
  let podstawa = null;
  let rodzaj = null;
  if (wybor === '') {
    if (zwolniona) bledy.push('Firma zwolniona z VAT musi mieć podstawę zwolnienia — wybierz ją z listy.');
  } else if (wybor === 'art113') {
    podstawa = PODSTAWA_ART_113; rodzaj = 'ustawa';
  } else if (wybor === 'art43') {
    const pkt = /^\d{1,2}$/u.test(wpisane.punkt) ? Number(wpisane.punkt) : NaN;
    if (!(pkt >= 1 && pkt <= 41)) bledy.push('Numer punktu art. 43 ust. 1 to liczba od 1 do 41.');
    if (wpisane.litera !== '' && !/^[a-z]$/u.test(wpisane.litera)) bledy.push('Litera punktu to jedna mała litera a–z (albo puste pole).');
    if (!bledy.length) {
      podstawa = `art. 43 ust. 1 pkt ${pkt}${wpisane.litera ? ` lit. ${wpisane.litera}` : ''} ustawy o VAT`;
      rodzaj = 'ustawa';
    }
  } else if (wybor === 'inna') {
    if (wpisane.podstawa_tekst === '') bledy.push('Wpisz podstawę zwolnienia (przepis ustawy, dyrektywy albo inny).');
    else if (wpisane.podstawa_tekst.length > MAKS_PODSTAWY) bledy.push(`Podstawa zwolnienia może mieć najwyżej ${MAKS_PODSTAWY} znaków.`);
    if (!RODZAJE_ZWOLNIENIA.includes(wpisane.rodzaj)) bledy.push('Wybierz rodzaj podstawy: ustawa, dyrektywa albo inna.');
    if (!bledy.length) { podstawa = wpisane.podstawa_tekst; rodzaj = wpisane.rodzaj; }
  } else {
    bledy.push('Wybierz podstawę zwolnienia z listy.');
  }
  return { ustawienia: bledy.length ? null : { zwolniona, podstawa, rodzaj }, bledy, wpisane };
}

/** Zapis z bazy albo `null` (brak wpisu, zepsuty JSON). */
export function czytajZwolnienie(db) {
  const w = db?.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?').get(KLUCZ)?.wartosc;
  if (typeof w !== 'string') return null;
  try {
    const z = JSON.parse(w);
    if (!z || typeof z !== 'object') return null;
    const podstawa = tekst(z.podstawa) || null;
    return { zwolniona: z.zwolniona === true && podstawa !== null, podstawa,
      rodzaj: podstawa && RODZAJE_ZWOLNIENIA.includes(z.rodzaj) ? z.rodzaj : null };
  } catch {
    return null;
  }
}

export function zapiszZwolnienie(db, { zwolniona, podstawa, rodzaj }) {
  if (zwolniona === true && !tekst(podstawa)) throw new Error('Firma zwolniona z VAT bez podstawy zwolnienia — nic nie zapisano.');
  if (tekst(podstawa) && !RODZAJE_ZWOLNIENIA.includes(rodzaj)) throw new Error(`Rodzaj podstawy spoza listy: „${rodzaj}”.`);
  const wartosc = JSON.stringify({ zwolniona: zwolniona === true, podstawa: tekst(podstawa) || null, rodzaj: tekst(podstawa) ? rodzaj : null });
  db.prepare(`INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES (?, ?, ?)
    ON CONFLICT(klucz) DO UPDATE SET wartosc = excluded.wartosc, zmienione_at = excluded.zmienione_at`)
    .run(KLUCZ, wartosc, new Date().toISOString());
}

/**
 * Dla adaptera TwojeFaktury (`programTwojeFaktury({ zwolnienie: () => zwolnienieDlaProgramu(db) })`):
 * `{ zwolniona, podstawa, rodzaj }` albo `null`, gdy podstawy (albo jej rodzaju) nie zapisano — pozycja „zw” dostaje
 * wtedy odmowę adaptera. Czytane przy każdym wystawieniu.
 * @returns {{ zwolniona: boolean, podstawa: string, rodzaj: string } | null}
 */
export function zwolnienieDlaProgramu(db) {
  const z = czytajZwolnienie(db);
  return z && z.podstawa && z.rodzaj ? { zwolniona: z.zwolniona, podstawa: z.podstawa, rodzaj: z.rodzaj } : null;
}

/**
 * PRZ-122.B07d: jedno źródło prawdy „sprzedawca zwolniony z VAT” dla usług faktur — `true` tylko przy programie
 * wbudowanym (lista stawek z „zw”, `opcjeZwProgramu`) i zapisanym zwolnieniu firmy. Przy inFakcie zawsze `false`
 * (zachowanie bez zmian). Czytane przy każdym żądaniu: rezygnacja ze zwolnienia działa bez restartu.
 */
export function sprzedawcaZwolniony(db, opisProgramu) {
  return zwolnionaZFlagi(db, opcjeZwProgramu(opisProgramu));
}

/**
 * PRZ-122.B07f: ta sama reguła dla wołających, które mają już flagę `{ zw }` programu zamiast jego opisu (usługa
 * proformy, `zmienUstalenia`) — `true` tylko przy `zw === true` i zapisanym zwolnieniu firmy.
 */
export function zwolnionaZFlagi(db, opcje) {
  return opcje?.zw === true && czytajZwolnienie(db)?.zwolniona === true;
}

/** Zapis → pola formularza (wybór z listy, punkt, litera, tekst) — do wypełnienia ekranu. */
export function polaFormularzaZwolnienia(z) {
  const pola = { zwolniona: z?.zwolniona === true, podstawa: '', punkt: '', litera: '', podstawa_tekst: '', rodzaj: 'ustawa' };
  if (!z?.podstawa) return pola;
  if (z.podstawa === PODSTAWA_ART_113) return { ...pola, podstawa: 'art113' };
  const m = ART_43.exec(z.podstawa);
  if (m) return { ...pola, podstawa: 'art43', punkt: m[1], litera: m[2] ?? '' };
  return { ...pola, podstawa: 'inna', podstawa_tekst: z.podstawa, rodzaj: z.rodzaj ?? 'inna' };
}
