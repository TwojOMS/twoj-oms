// Czy wzor wysylamy paczkomatem. Kolumna „Paczkomat" w magazynie.
//
// ⚠️ POLE USTAWIANE WYLACZNIE RECZNIE — decyzja wlasciciela z 2026-08-06.
// Wczesniejszy projekt wyliczal odpowiedz z rozmiaru (prog 640 mm, najdluzszy wymiar
// wewnetrzny gabarytu InPostu) i pozwalal ja nadpisac. Regula wypadla, bo placila dwa razy:
// raz brakiem wymiarow (okolo 588 wzorow ich nie ma), raz falszywa pewnoscia przy szablonie
// zwinietym w rulon, ktory prog „na plasko" odrzuca, a ktory realnie sie miesci.
// Wlasciciel oznacza to sam, hurtem — patrz edycja masowa.
export const PACZKOMAT_WARTOSCI = new Set(['tak', 'nie']);

// ⚠️ TRZY STANY, NIE DWA. `null` znaczy „jeszcze nieoznaczone" i to CO INNEGO niz 'nie':
// pierwsze jest robota do wykonania, drugie decyzja. Lista brakow liczy wlasnie te pierwsze.
export function czyPaczkomat(wzor) {
  const wartosc = wzor?.paczkomat;
  return PACZKOMAT_WARTOSCI.has(wartosc) ? wartosc : null;
}
