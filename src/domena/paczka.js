// Parsowanie wagi i wymiarow paczki z formularza HTML ekranu nadania.
//
// Czlowiek wpisze przecinek dziesietny ('1,5') — to NIE jest blad wpisu, tylko polska
// klawiatura, wiec zamieniamy go na kropke PRZED proba odczytania liczby, zamiast
// odrzucac poprawna wartosc.
//
// Kazda z czterech wartosci jest walidowana NIEZALEZNIE i musi byc liczba WIEKSZA OD
// ZERA. Wartosc nieliczbowa, ujemna albo zerowa to ZAWSZE odmowa z czytelnym komunikatem
// — NIGDY ciche podstawienie wartosci domyslnej. Przed ta poprawka trasa HTTP w ogole nie
// przekazywala formularza dalej, wiec KAZDA paczka jechala jako 1 kg / 40x30x10 cm — DPD
// rozlicza po wadze i gabarycie, wiec to byly realne pieniadze, nie kosmetyka.
const ETYKIETY_POL = { waga: 'waga', dlugosc: 'długość', szerokosc: 'szerokość', wysokosc: 'wysokość' };

// ⚠️ WYEKSPORTOWANA 2026-08-17 dla ekranu ustawień (domain/ustawienia-panelu.js). Ta sama
// reguła musi rządzić formularzem nadania i formularzem wartości domyślnych — druga kopia
// rozjechałaby się na przecinku dziesiętnym albo na zerze, czyli dokładnie tam, gdzie boli.
export function liczbaDodatnia(surowa) {
  const znormalizowana = String(surowa ?? '').trim().replace(',', '.');
  if (!znormalizowana) return null;
  const liczba = Number(znormalizowana);
  return Number.isFinite(liczba) && liczba > 0 ? liczba : null;
}

/**
 * Zwraca { paczka } z czterema liczbami (waga, dlugosc, szerokosc, wysokosc), albo
 * { blad } z czytelnym komunikatem dla operatora, gdy ktorakolwiek wartosc jest zla.
 *
 * ⚠️ WYLACZNIE DPD. Paczkomat ma wlasny parser (parsujPaczkeInpost nizej) — patrz
 * komentarz przy nim, dlaczego to DWIE funkcje, a nie jedna z rozgalezieniem.
 */
export function parsujPaczke(dane) {
  const paczka = {};
  const bledne = [];
  for (const pole of Object.keys(ETYKIETY_POL)) {
    const liczba = liczbaDodatnia(dane?.[pole]);
    if (liczba === null) bledne.push(ETYKIETY_POL[pole]);
    else paczka[pole] = liczba;
  }
  if (bledne.length) {
    return {
      blad: `Nieprawidłowa wartość pola: ${bledne.join(', ')} — każda wartość musi być liczbą większą od zera.`,
    };
  }
  return { paczka };
}

// ---------------------------------------------------------------------------------
// GABARYT PACZKOMATU (Zadanie 7, InPost)
//
// InPost NIE PRZYJMUJE wymiarow — przyjmuje SZABLON skrytki (kurierzy/inpost.js:
// SZABLONY_GABARYTU: A→small, B→medium, C→large). Wymiary ponizej sa ZMIERZONE na zywym
// koncie (rozpoznanie, sekcja 4.1) i istnieja WYLACZNIE do pokazania operatorowi, ktora
// litera to jaka skrzynka — dokladnie jak w formularzu Apilo, ktory operator zna z
// pamieci: nikt nie pamieta liter, ale kazdy rozpozna wymiary swojej paczki.
//
// ⚠️ Domyslne wymiary panelu (110×75×1 cm, PACZKA_DOMYSLNA w domain/ustawienia-panelu.js —
// od 17.08.2026 sa FALLBACKIEM ustawienia operatora, a nie jedyna wartoscia) sa dla
// PLASKIEJ paczki wielkoformatowej i NIE MIESZCZA SIE w zadnej skrytce automatu —
// dlatego gabaryt jest WYBOREM ze skonczonego zbioru, nigdy polem tekstowym z domyslna
// wartoscia.
// ---------------------------------------------------------------------------------
export const GABARYTY_PACZKOMATU = {
  A: '8 × 38 × 64 cm',
  B: '19 × 38 × 64 cm',
  C: '41 × 38 × 64 cm',
};

/**
 * Parsowanie wagi i gabarytu z formularza ekranu nadania — WYLACZNIE dla `inpost_paczkomat`.
 *
 * Osobna funkcja od parsujPaczke, NIE galaz w tamtej: brief Zadania 7 wymaga, zeby sciezka
 * DPD zostala „dokladnie jak dzis, ani jednej zmiany" — a rozgalezienie wewnatrz jednej
 * funkcji jest dokladnie tym rodzajem zmiany, ktora najlatwiej przez przypadek dotyka
 * kodu, ktorego nie wolno ruszac.
 *
 * Gabaryt NIGDY nie ma cichej domyslnej wartosci przy PARSOWANIU (ekran ma domyslnie
 * ZAZNACZONY wybor A — to inna sprawa, patrz nadaj.ejs): brak litery albo litera spoza
 * A/B/C to zawsze odmowa, tak samo jak zle wymiary przy DPD — zgloszenie zlego gabarytu
 * to paczka, ktora fizycznie nie zmiesci sie w automacie, czyli realne pieniadze za
 * nieudane nadanie, nie kosmetyka formularza.
 */
export function parsujPaczkeInpost(dane) {
  const waga = liczbaDodatnia(dane?.waga);
  if (waga === null) {
    return { blad: 'Nieprawidłowa wartość pola: waga — musi być liczbą większą od zera.' };
  }
  const gabaryt = String(dane?.gabaryt ?? '').trim().toUpperCase();
  if (!Object.hasOwn(GABARYTY_PACZKOMATU, gabaryt)) {
    return {
      blad: `Nieprawidłowy gabaryt paczkomatu: „${dane?.gabaryt ?? ''}” — wybierz jeden z: `
        + `${Object.keys(GABARYTY_PACZKOMATU).join(', ')}.`,
    };
  }
  return { paczka: { waga, gabaryt } };
}
