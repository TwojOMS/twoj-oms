import { adresOdbiorcy } from './adres-odbiorcy.js';
import { daneFaktury } from './dane-faktury.js';

// NA JAKI ADRES PISZEMY DO KLIENTA — jedna reguła na wszystkie maile z karty (22.08.2026).
//
// Wyjęte z `domain/potwierdzenie-zamowienia.js`, gdzie mieszkało prywatnie, bo od 22.08
// tego samego adresu potrzebują jeszcze trzy maile (proforma, faktura, przypomnienie).
// Druga kopia tej reguły znaczyłaby, że potwierdzenie idzie do zamawiającego, a faktura
// do księgowości — dla tego samego zamówienia, bez ostrzeżenia.
//
// Treść przeniesiona bez zmian: to przeprowadzka, nie ulepszanie.

/**
 * Adres e-mail klienta albo `null`.
 *
 * ⚠️ NAJPIERW ADRES ZAMAWIAJĄCEGO, dopiero potem ten z danych do faktury. Mail z faktury bywa
 * adresem księgowości — a piszemy do osoby, która zamówienie złożyła i która rozpozna sprawę.
 */
export function adresatKlienta(z) {
  return adresOdbiorcy(z)?.email || daneFaktury(z)?.email || null;
}
