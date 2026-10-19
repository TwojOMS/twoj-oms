import { PALETA_STATUSOW, domyslneStatusy } from '../../domena/statusy-konfiguracja.js';
const DOMYSLNE_KOLORY = Object.fromEntries(domyslneStatusy().map(s => [s.klucz, s.kolor]));
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
export function modyfikatorStatusu(status, konfiguracja) {
  if (konfiguracja) {
    const kolor = konfiguracja.find(s => s.klucz === status)?.kolor;
    if (kolor && kolor === DOMYSLNE_KOLORY[status]) return KLASY[status];
    return kolor && Object.hasOwn(PALETA_STATUSOW, kolor) ? `znacznik--${PALETA_STATUSOW[kolor].klasa}` : '';
  }
  return KLASY[status] ?? '';
}

/** Komplet klas dla znacznika statusu: `znacznik` + modyfikator koloru. */
export function klasaStatusu(status, konfiguracja) {
  return `znacznik ${modyfikatorStatusu(status, konfiguracja)}`.trim();
}
