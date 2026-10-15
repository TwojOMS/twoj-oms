/** Reguła sumy brutto → netto: jawna lista WDT, pozostałe zamówienia VAT 23%. */
export const nettoZamowieniaGrosze = (bruttoGr, email, klienciWdt = new Set()) => (
  klienciWdt.has(String(email ?? '').toLowerCase()) ? bruttoGr : Math.round(bruttoGr / 1.23)
);
