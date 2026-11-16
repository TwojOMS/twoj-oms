import { PALETA_STATUSOW, domyslneStatusy } from '../../domena/statusy-konfiguracja.js';
const DOMYSLNE_KOLORY = Object.fromEntries(domyslneStatusy().map(s => [s.klucz, s.kolor]));
// KOLOR STATUSU — czysta prezentacja, dlatego mieszka w core/web/, a nie w domenie. Domena
// (domena/status.js) rozstrzyga, JAKI status ma zamówienie; tutaj rozstrzyga się tylko,
// jak go pomalować, i sama zmiana barwy nie ma prawa niczego znaczyć.
//
// Wspólne dla listy i karty zamówienia (przez `defaultContext` w core/web/pipeline.js), bo ten
// sam status musi wyglądać tak samo w obu miejscach — dwie kopie mapy rozjechałyby się
// przy pierwszej zmianie palety i „Wysłane” byłoby zielone na liście, a szare na karcie.
//
// ⚠️ Klucze muszą być te same, co w ETYKIETY (domena/status.js). Status bez wpisu dostaje wygląd
// NEUTRALNY, a nie wyjątek: dołożenie statusu w domenie nie może wywalić ekranu, najwyżej zostawić
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
