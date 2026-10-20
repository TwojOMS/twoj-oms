// Jedyna lista ekranów, które właściciel może wyłączyć. To nie są uprawnienia ról.
export const MODULY_OPCJONALNE = Object.freeze([
  { klucz: 'klienci', nazwa: 'Stali klienci', opis: 'Karty stałych klientów i edycja ich warunków handlowych.' },
  { klucz: 'okresy', nazwa: 'Rozliczenia', opis: 'Miesięczne rozliczenia klientów i faktury za okres.' },
  // PRZ-102.22: wyłączenie zdejmuje ekran Koszty i nocne pobieranie z KSeF; koszty już w bazie zostają w Finansach.
  { klucz: 'koszty', nazwa: 'Koszty', opis: 'Faktury kosztowe: ekran Koszty, nocne pobieranie faktur zakupowych z KSeF, koszty dopisane ręcznie i paczka kosztów dla biura.' },
]);
export const dozwolonyModul = klucz => MODULY_OPCJONALNE.some(m => m.klucz === klucz);

export function parsujWylaczoneModuly(wartosc) {
  try {
    const lista = JSON.parse(wartosc);
    if (!Array.isArray(lista) || !lista.every(dozwolonyModul)) return [];
    return [...new Set(lista)];
  } catch { return []; }
}
