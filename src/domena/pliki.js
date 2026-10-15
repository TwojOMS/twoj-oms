// Numer zamowienia pochodzi WPROST ze sklepu, a polskie wtyczki numeracji swobodnie
// wstawiaja ukosniki (format „1301/07/2026"). Wklejony do sciezki bez oczyszczenia
// wyprowadza zapis poza katalog etykiet — a sciezka trafia potem do bazy i jest
// serwowana przez GET /etykieta.
//
// Biala lista zamiast czarnej: zostawiamy litery (takze polskie), cyfry, '_' i '-',
// reszte sklejamy w pojedynczy '_'. Dzieki temu ani '/', ani '\', ani '..', ani znak
// NUL nie maja jak przetrwac. Wynik pusty (np. numer '..' albo '///') zastepujemy
// stala, bo pusta nazwa pliku to znowu zapis do samego katalogu.
export function bezpiecznaNazwa(tekst, zastepnik = 'bez-numeru') {
  const oczyszczone = String(tekst ?? '')
    .replace(/[^\p{L}\p{N}_-]+/gu, '_')
    .replace(/^[_-]+|[_-]+$/g, '');
  return oczyszczone || zastepnik;
}
