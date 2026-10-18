// Kolumna „Klient” na liście zamówień (PRZ-094.19): co wypisać i w jakiej kolejności.
//
// Trzy linie, każda tylko gdy ma treść:
//   1. imię i nazwisko — a gdy zamówienie ich nie ma (firma bez osoby kontaktowej), nazwa firmy;
//   2. nazwa firmy — gdy jest osoba I firma, i firma nie jest tym samym napisem co osoba;
//   3. login kupującego — wyłącznie w kanale Allegro (to Allegro nadaje loginy; w Woo takiego pojęcia nie ma).
//
// ⚠️ Do 18.10.2026 komórka pokazywała firmę ZAMIAST imienia i nazwiska (`company || osoba`). Prośba właściciela:
// osoba na górze, firma pod nią — obie informacje, a nie jedna z dwóch.
//
// ⚠️ LOGIN JEST W BLOKU `klient` ZAMÓWIENIA (mapowanie Allegro: domena/allegro-mapowanie.js), więc lista
// czyta go z tego samego JSON-a co imię i nazwisko — bez `surowe_json` i bez dodatkowego zapytania. Zamówienia
// zapisane przed tą zmianą loginu nie mają, dopóki poller nie zapisze ich ponownie; wtedy trzeciej linii brak.
//
// Czysta funkcja: dostaje blok klienta i rodzaj kanału (`rodzajKanalu`, domena/kanaly.js), nic nie czyta z bazy.
const napis = (v) => (typeof v === 'string' ? v.trim() : '');
// Porównanie „to samo imię i nazwisko": bez różnicy wielkości liter i krotności spacji.
const porownawcza = (s) => s.toLocaleLowerCase('pl').replace(/\s+/g, ' ');

/**
 * @param {Record<string, unknown> | null | undefined} klient blok `klient` zamówienia (klucze jak w Woo `billing`)
 * @param {{ klucz: string } | null | undefined} rodzaj rodzaj kanału zamówienia
 * @returns {{ nazwa: string, firma: string, login: string }} puste napisy = linii nie pokazujemy
 */
export function klientListy(klient, rodzaj) {
  const osoba = [napis(klient?.first_name), napis(klient?.last_name)].filter(Boolean).join(' ');
  const firma = napis(klient?.company);
  const login = rodzaj?.klucz === 'allegro' ? napis(klient?.login) : '';
  if (!osoba) return { nazwa: firma, firma: '', login };
  const takaSama = firma && porownawcza(firma) === porownawcza(osoba);
  return { nazwa: osoba, firma: firma && !takaSama ? firma : '', login };
}
