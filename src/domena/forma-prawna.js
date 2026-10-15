// Skrót formy prawnej w nazwie firmy — WYŁĄCZNIE do wyświetlania w wąskich kolumnach (PRZ-078).
// inFakt oddaje nazwę nabywcy tak, jak stoi w rejestrze: „… SPÓŁKA Z OGRANICZONĄ
// ODPOWIEDZIALNOŚCIĄ" wielkimi literami. Najdłuższe słowo tej frazy nie łamie się, więc jedna
// taka faktura rozpychała tabelę Faktur o ~100 px (pomiar na produkcji 14.10.2026: 1091/911 px
// przy oknie 1280 px). Pełna nazwa zostaje w podpowiedzi — ta funkcja niczego nie zapisuje.

const FORMY = [
  [/spółka\s+z\s+ograniczoną\s+odpowiedzialnością/iu, 'sp. z o.o.'],
  [/spółka\s+akcyjna/iu, 'S.A.'],
  [/spółka\s+komandytowa/iu, 'sp.k.'],
  [/spółka\s+jawna/iu, 'sp.j.'],
  [/spółka\s+cywilna/iu, 's.c.'],
];

/** @param {string | null | undefined} nazwa */
export function skrocFormePrawna(nazwa) {
  let wynik = String(nazwa ?? '').replace(/\s+/g, ' ').trim();
  for (const [wzor, skrot] of FORMY) wynik = wynik.replace(wzor, skrot);
  return wynik;
}
