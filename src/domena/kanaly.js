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
