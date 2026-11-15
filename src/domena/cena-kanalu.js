// Cena w kanale = cena brutto karty powiększona o narzut konta (D45, wspólne dla ERLI i Allegro).
// Komunikaty zostają w kanałach — tu tylko kody: 'cena', 'narzut', 'zakres'.

/**
 * @param {number} cenaGr cena brutto karty w groszach (całkowita, > 0)
 * @param {number} narzutBp narzut w punktach bazowych (całkowity, ≥ 0; 1250 = 12,5%)
 * @returns {{ bledy: string[], grosze: number | null }}
 */
export function cenaZNarzutem(cenaGr, narzutBp) {
  const bledy = [];
  if (!Number.isSafeInteger(cenaGr) || cenaGr <= 0) bledy.push('cena');
  if (!Number.isSafeInteger(narzutBp) || narzutBp < 0) bledy.push('narzut');
  if (bledy.length) return { bledy, grosze: null };
  // BigInt zachowuje dokładność mnożenia także powyżej zakresu Number.
  // Dodanie połowy dzielnika daje zaokrąglenie połówką w górę.
  const grosze = (BigInt(cenaGr) * (10000n + BigInt(narzutBp)) + 5000n) / 10000n;
  if (grosze > BigInt(Number.MAX_SAFE_INTEGER)) return { bledy: ['zakres'], grosze: null };
  return { bledy: [], grosze: Number(grosze) };
}

/** Grosze → „<zł>.<gr>” (6638 → "66.38"), zapis kwoty Allegro `sellingMode.price.amount`. */
export function kwotaDziesietna(grosze) {
  const g = BigInt(grosze);
  return `${g / 100n}.${String(g % 100n).padStart(2, '0')}`;
}
