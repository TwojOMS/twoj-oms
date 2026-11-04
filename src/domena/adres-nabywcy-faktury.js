// PRZ-126.PT5: adres nabywcy na fakturze — JEDNA reguła dla odmowy serwera
// (faktura-odmowa.js) i dla przycisku na karcie (wystawienie-faktury.js).
//
// Art. 106e ust. 1 pkt 3 ustawy o VAT wymaga adresu nabywcy na KAŻDEJ fakturze, także dla
// osoby prywatnej bez NIP. Bez tej reguły TF wysyłał do KSeF FA(3) bez elementu Adres.
// Wejście to `daneFaktury(z)` — adres uzupełniony ręcznie na karcie wygrywa ze sklepem.
// Kod pocztowy wymagany tylko w Polsce (pusty kraj = 'PL'): są kraje bez kodów, a FA(3) ma
// wolny AdresL1/L2. Formatu kodu tu nie sprawdzamy (osobna zmiana).

const pusty = (v) => !String(v ?? '').trim();

// Sklep albo ręczny wpis bywa pełną nazwą zamiast kodu ISO — „Polska” też jest Polską.
const POLSKA = new Set(['PL', 'POLSKA', 'POLAND', 'RZECZPOSPOLITA POLSKA']);

/** Braki adresu nabywcy, kolejno: 'ulica', 'kod pocztowy', 'miasto'. Pusta tablica = adres pełny. */
export function brakiAdresuNabywcy(dane) {
  const kraj = String(dane?.kraj ?? '').trim().toUpperCase() || 'PL';
  const braki = [];
  if (pusty(dane?.ulica)) braki.push('ulica');
  if (POLSKA.has(kraj) && pusty(dane?.kod)) braki.push('kod pocztowy');
  if (pusty(dane?.miasto)) braki.push('miasto');
  return braki;
}

/** „ulica, kod pocztowy” — wspólne dla zdania serwera i przycisku. */
export function zdanieBrakuAdresu(braki) {
  return braki.join(', ');
}
