// Katalog jest zależnością konkretnej instalacji, nigdy globalną mapą firmy.
const WBUDOWANE = Object.freeze([{klucz:'reczne',etykieta:'ręczne'},{klucz:'indywidualne',etykieta:'Indywidualne'}]);
export function kanalyWidoku(definicje) {
  if (!Array.isArray(definicje)) throw new TypeError('Wymagana jawna lista definicji kanałów');
  return [...definicje.map(k=>({klucz:k.klucz,etykieta:k.etykieta ?? k.klucz})),...WBUDOWANE.map(k=>({...k}))];
}
export function adresKanalu(sklep, definicje) {
  const kanaly=kanalyWidoku(definicje);
  return kanaly.find(k=>k.klucz===sklep)?.etykieta ?? sklep;
}

// RODZAJ KANAŁU DO PLAKIETKI NA LIŚCIE ZAMÓWIEŃ (PRZ-094.17). Bierzemy go z `typ` w definicji
// kanału (OMS_KANALY), NIGDY z nazwy: nazwę sklepu wpisuje firma („Pracownia Półcień"), a „typ"
// mówi, czy za kluczem stoi Allegro, czy WooCommerce. Kanały bez marki (ręczne, indywidualne,
// nieznany klucz) → `null`, czyli bez plakietki. `znak` to jedyna litera plakietki; pełna nazwa
// idzie w `title` i `aria-label`, więc czytnik ekranu nie czyta samej litery.
export const RODZAJE_KANALOW = Object.freeze({
  allegro: Object.freeze({ klucz: 'allegro', nazwa: 'Allegro', znak: 'a' }),
  woo: Object.freeze({ klucz: 'woo', nazwa: 'WooCommerce', znak: 'W' }),
});
export function rodzajKanalu(sklep, definicje) {
  if (!Array.isArray(definicje)) return null;
  const k = definicje.find((d) => d?.klucz === sklep);
  return k && Object.hasOwn(RODZAJE_KANALOW, k.typ) ? RODZAJE_KANALOW[k.typ] : null;
}
