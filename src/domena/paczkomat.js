// Czy karte wysylamy paczkomatem. Kolumna „Paczkomat" w magazynie.
//
// ⚠️ POLE USTAWIANE WYŁĄCZNIE RĘCZNIE.
// Wcześniejszy projekt wyliczał odpowiedź z rozmiaru (próg 640 mm, najdłuższy wymiar
// wewnętrzny gabarytu InPostu) i pozwalał ją nadpisać. Reguła wypadła, bo płaciła dwa razy:
// raz brakiem wymiarów (wielu kart ich nie ma), raz fałszywą pewnością przy produkcie
// zwiniętym w rulon, który próg „na płasko" odrzuca, a który realnie się mieści.
// Operator oznacza to sam, hurtem — patrz edycja masowa.
export const PACZKOMAT_WARTOSCI = new Set(['tak', 'nie']);

// ⚠️ TRZY STANY, NIE DWA. `null` znaczy „jeszcze nieoznaczone" i to CO INNEGO niz 'nie':
// pierwsze jest robota do wykonania, drugie decyzja. Lista brakow liczy wlasnie te pierwsze.
export function czyPaczkomat(karta) {
  const wartosc = karta?.paczkomat;
  return PACZKOMAT_WARTOSCI.has(wartosc) ? wartosc : null;
}
