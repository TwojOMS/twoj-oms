// PRZ-093.08 — adres firmy wpisany w Ustawieniach → Firma (dla instalacji bez DPD_NADAWCA_* w pliku).
// Kolejność źródeł i odczyt z pliku: src/core/adres-firmy.ts. Zapis i odczyt z bazy: src/oms/db/adres-firmy.js.
// Adres firmy NIE jest sekretem — stoi na każdej proformie i etykiecie — więc trzymamy go w jawnych ustawieniach.

export const KLUCZ_ADRESU_FIRMY = 'firma';
export const EKRAN_ADRESU_FIRMY = '/ustawienia/firma';

const tekst = (v) => String(v ?? '').trim().replace(/\s+/gu, ' ');
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/**
 * Sprawdza formularz. Wymagane: nazwa, ulica, kod, miasto, kraj (dwuliterowy kod, domyślnie PL).
 * Kod pocztowy dla PL w postaci NN-NNN (pięć cyfr bez kreski też przyjmujemy i zapisujemy z kreską).
 * Telefon i e-mail opcjonalne — sprawdzane, gdy wpisane.
 * @returns {{ ustawienia: object, bledy: string[] }}
 */
export function sprawdzFormularzFirmy(body = {}) {
  const bledy = [];
  const nazwa = tekst(body.nazwa);
  const ulica = tekst(body.ulica);
  const miasto = tekst(body.miasto);
  const kraj = tekst(body.kraj).toUpperCase() || 'PL';
  let kod = tekst(body.kod);
  const telefon = tekst(body.telefon);
  const email = tekst(body.email);

  if (!nazwa) bledy.push('Podaj nazwę firmy.');
  else if (nazwa.length > 100) bledy.push('Nazwa firmy może mieć najwyżej 100 znaków.');
  if (!ulica) bledy.push('Podaj ulicę z numerem.');
  else if (ulica.length > 100) bledy.push('Ulica może mieć najwyżej 100 znaków.');
  if (!miasto) bledy.push('Podaj miasto.');
  else if (miasto.length > 60) bledy.push('Miasto może mieć najwyżej 60 znaków.');
  if (!/^[A-Z]{2}$/u.test(kraj)) bledy.push('Kraj to dwuliterowy kod, np. PL albo DE.');
  if (!kod) bledy.push('Podaj kod pocztowy.');
  else if (kraj === 'PL') {
    if (/^\d{5}$/u.test(kod)) kod = `${kod.slice(0, 2)}-${kod.slice(2)}`;
    if (!/^\d{2}-\d{3}$/u.test(kod)) bledy.push('Polski kod pocztowy ma postać NN-NNN, np. 00-950.');
  } else if (kod.length > 12) bledy.push('Kod pocztowy może mieć najwyżej 12 znaków.');
  if (telefon && !/^\+?[\d\s()-]{6,20}$/u.test(telefon)) bledy.push('Telefon: same cyfry (może być + na początku, spacje i kreski).');
  if (email && (email.length > 120 || !EMAIL.test(email))) bledy.push('Podaj poprawny adres e-mail, np. biuro@firma.pl.');

  return { ustawienia: { nazwa, ulica, kod, miasto, kraj, telefon, email }, bledy };
}

/**
 * Wiersz z bazy → adres w kształcie nadawcy (jak z pliku). Niepełny zapis = brak adresu, nie połowa.
 * @returns {import('../core/adres-firmy.ts').AdresFirmy | null}
 */
export function adresFirmyZZapisu(zapis) {
  const u = zapis?.ustawienia;
  if (!u) return null;
  const a = { nazwa: tekst(u.nazwa), ulica: tekst(u.ulica), kod: tekst(u.kod), miasto: tekst(u.miasto),
    kraj: tekst(u.kraj) || 'PL', phone: tekst(u.telefon), email: tekst(u.email) };
  return a.nazwa && a.ulica && a.kod && a.miasto ? a : null;
}

/**
 * JEDNA kolejność źródeł: plik (gdy stoi w nim choć jedno pole adresu — wtedy w całości) → baza → brak.
 * @param {{ wPliku: boolean, zPliku: import('../core/adres-firmy.ts').AdresFirmy, zapis: () => any }} o
 *   — `zapis` czytany tylko, gdy pliku nie ma
 * @returns {{ adres: import('../core/adres-firmy.ts').AdresFirmy | null, zrodlo: 'plik'|'baza'|null }}
 */
export function rozstrzygnijAdresFirmy({ wPliku, zPliku, zapis }) {
  if (wPliku) return { adres: zPliku, zrodlo: 'plik' };
  const zBazy = adresFirmyZZapisu(zapis());
  return zBazy ? { adres: zBazy, zrodlo: 'baza' } : { adres: null, zrodlo: null };
}
