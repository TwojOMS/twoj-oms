// ⚠️⚠️ TO JEST JEDYNE MIEJSCE W MODULE KOSZTOW, KTORE ZNA STREFE WARSZAWY. Ten projekt
// przejechal sie na strefach dwa razy (kursor `date_modified`, data proformy w UTC), a czuwacz
// KSeF chodzi co godzine cala dobe WLASNIE po to, zeby nie zakladac trzeciego takiego miejsca.
// Tutaj wlasciciel poprosil o pobranie nocne, wiec strefa jest potrzebna — ale wylacznie do
// ODCZYTU godziny, nigdy do arytmetyki dat. Zadnego dodawania godzin, zadnego `setHours`.
//
// ⚠️ ODPOWIEDZ DOTYCZY CALEJ GODZINY 03:00–03:59, a nie rownej godziny: zegar czuwacza tyka
// co godzine od chwili startu kontenera i nie ma zadnego powodu trafiac w rowna minute.
// `hourCycle: 'h23'` jest tu istotny — bez niego polnoc wychodzi jako „24", a nie „0".
const GODZINA_POBRANIA = 3;

// ⚠️ CO ILE WRACA OKNO POBRANIA — czyli ile czasu ma przebieg, zanim zacznie zjadac WLASNE
// nastepne okno. To jest miara, wzgledem ktorej `bootstrap.js` sprawdza najgorszy przypadek
// czuwacza kosztow (a nie odstep zegara: zegar tyka co godzine, ale 23 tykniecia na dobe
// i tak oddaja „nie ta pora", wiec przebieg dluzszy niz godzina nie kosztuje niczego).
export const ODSTEP_OKNA_POBRANIA_MS = 24 * 60 * 60 * 1000;

// `godzina` jest parametrem, bo dwa nocne czuwacze (koszty 3:00, archiwum sprzedazy 4:00)
// maja NIE nachodzic na siebie; domyslna wartosc zostaje dla dotychczasowych wywolan.
export function czyPoraPobrania(chwila, godzina = GODZINA_POBRANIA) {
  const biezaca = Number(new Intl.DateTimeFormat('pl-PL', {
    timeZone: 'Europe/Warsaw', hour: 'numeric', hourCycle: 'h23',
  }).format(chwila));
  return biezaca === godzina;
}
