// Jedyna lista ekranów, które sprzedawca może wyłączyć. To nie są uprawnienia ról.
export const MODULY_OPCJONALNE = Object.freeze([
  { klucz: 'klienci', nazwa: 'Klienci B2B', opis: 'Karty klientów B2B i edycja ich warunków handlowych.' },
  { klucz: 'okresy', nazwa: 'Rozliczenia', opis: 'Miesięczne rozliczenia klientów i faktury za okres.' },
  // Wyłączenie zdejmuje ekran Koszty i nocne pobieranie z KSeF; koszty już w bazie zostają w Finansach.
  { klucz: 'koszty', nazwa: 'Koszty', opis: 'Faktury kosztowe: ekran Koszty, nocne pobieranie faktur zakupowych z KSeF, koszty dopisane ręcznie i zestawienie faktur kosztowych.' },
]);
export const dozwolonyModul = klucz => MODULY_OPCJONALNE.some(m => m.klucz === klucz);

export function parsujWylaczoneModuly(wartosc) {
  try {
    const lista = JSON.parse(wartosc);
    if (!Array.isArray(lista) || !lista.every(dozwolonyModul)) return [];
    return [...new Set(lista)];
  } catch { return []; }
}
