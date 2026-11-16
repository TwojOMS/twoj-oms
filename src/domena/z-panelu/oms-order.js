/**
 * Przedrostek ZNACZNIKA TECHNICZNEGO, który panel wpisuje zamówieniu w pole `uwagi`.
 *
 * ⚠️⚠️ TO POLE NIESIE DWIE RÓŻNE RZECZY I TRZEBA JE ODRÓŻNIAĆ. `zamowienia.uwagi` to
 * normalnie **słowa klienta** (`customer_note` ze sklepu, `messageToSeller` z Allegro) —
 * a tutaj panel dopisuje własny ślad z identyfikatorem karty i odnośnikiem do niej.
 *
 * ⚠️ To KOPIA formatu z panelu indywidualnego (osobne repo panelu,
 * `src/domain/oms-order.js`) — tam znacznik powstaje, tu tylko go rozpoznajemy. Zmiana brzmienia
 * w panelu wymaga zmiany tutaj, inaczej znacznik zacznie po cichu wyciekać na kartkę w paczce
 * razem z wewnętrznym adresem karty. Pilnuje tego test z dosłownym tekstem panelu
 * (`tests/moduly/zamowienia/specyfikacja.test.js`, „znacznik techniczny panelu…”).
 * Czyta ją specyfikacja zamówienia (`src/domena/specyfikacja.js`) i zestawienie zamówień.
 */
export const UWAGA_Z_KARTY = 'Zamówienie indywidualne — karta ';
