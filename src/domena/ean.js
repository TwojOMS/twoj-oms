// PRZ-153.E5.3c — EAN karty produktu: 8 albo 13 cyfr z poprawną cyfrą kontrolną GTIN.
//
// Cyfra kontrolna GTIN: od prawej (bez ostatniej cyfry) wagi 3, 1, 3, 1…; kontrolna dopełnia sumę
// do wielokrotności 10. Ta sama reguła dla EAN-8 i EAN-13. Napis z odstępami w środku, literami albo
// inną długością (np. UPC-A, 12 cyfr) — nie jest EAN-em karty. Obcinanie odstępów na brzegach robi wołający.

/** @param {unknown} napis @returns {boolean} */
export function poprawnyEan(napis) {
  if (typeof napis !== 'string' || !/^(\d{8}|\d{13})$/.test(napis)) return false;
  const cyfry = [...napis].map(Number);
  const kontrolna = cyfry.pop();
  let suma = 0;
  cyfry.reverse().forEach((c, i) => { suma += c * (i % 2 === 0 ? 3 : 1); });
  return (10 - (suma % 10)) % 10 === kontrolna;
}
