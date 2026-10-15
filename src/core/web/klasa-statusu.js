// KOLOR STATUSU — czysta prezentacja, dlatego mieszka w web/, a nie w domain/. Domena
// (domain/status.js) rozstrzyga, JAKI status ma zamowienie; tutaj rozstrzyga sie tylko,
// jak go pomalowac, i sama zmiana barwy nie ma prawa niczego znaczyc.
//
// Wspolne dla listy i karty zamowienia (przez `defaultContext` w web/server.js), bo ten
// sam status musi wygladac tak samo w obu miejscach — dwie kopie mapy rozjechalyby sie
// przy pierwszej zmianie palety i „Wyslane" bylo by zielone na liscie, a szare na karcie.
//
// ⚠️ Klucze musza byc te same, co w ETYKIETY. Status bez wpisu dostaje wyglad NEUTRALNY,
// a nie wyjatek: dolozenie statusu w domenie nie moze wywalic ekranu, najwyzej zostawic
// nowy stan szarym do czasu dobrania mu barwy.
const KLASY = {
  nowe: 'znacznik--nowe',
  indywidualne: 'znacznik--indywidualne',
  w_realizacji: 'znacznik--w-realizacji',
  wyslane: 'znacznik--wyslane',
  zwrot: 'znacznik--zwrot',
  anulowane: 'znacznik--anulowane',
};

/** Sama klasa modyfikatora (albo pusty napis) — do kropki w panelu bocznym. */
export function modyfikatorStatusu(status) {
  return KLASY[status] ?? '';
}

/** Komplet klas dla znacznika statusu: `znacznik` + modyfikator koloru. */
export function klasaStatusu(status) {
  return `znacznik ${modyfikatorStatusu(status)}`.trim();
}
