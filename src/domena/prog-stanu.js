// Próg niskiego stanu karty z pola formularza (karta, edycja hurtem). Jedna reguła dla obu wejść — inaczej
// karta przyjmowałaby wartości, których hurt nie przyjmuje (albo odwrotnie).
//
// Puste pole to „bez progu” (`null`), a NIE zero: zero jest osobnym, świadomym progiem („ostrzegaj przy zerze”).
// Tylko cyfry: `Number('1e3')`, `'+2'` czy `'0x10'` dałyby liczbę, ale nikt tak nie wpisuje sztuk — to literówka,
// której nie zgadujemy.

const BLAD = 'Próg niskiego stanu to liczba całkowita od 0 w górę (np. 2) — albo puste pole, żeby nie ostrzegać.';

/**
 * @param {unknown} tekst wartość pola formularza
 * @returns {number|null|{blad: string}} próg, `null` (bez progu) albo odmowa
 */
export function parsujProg(tekst) {
  // Pole nieprzysłane albo przysłane dwa razy (Fastify oddaje wtedy tablicę) to nie „puste” — kasowanie progu
  // musi być świadomym pustym polem.
  if (typeof tekst !== 'string') return { blad: BLAD };
  const t = tekst.trim();
  if (t === '') return null;
  if (!/^\d+$/.test(t)) return { blad: BLAD };
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : { blad: BLAD };
}
