// Parametry własne kart — reguły czyste, bez bazy i bez HTTP.
//
// Każda firma opisuje produkty innymi cechami (kolor, materiał, moc), więc definiuje je sama w Ustawieniach.
// Ten plik jest JEDYNYM źródłem reguł dla Ustawień, karty produktu, edycji hurtem i filtra listy: gdyby każde
// wejście miało swoją walidację, hurt przyjąłby wartość, której karta nie przyjmuje, a filtr nie znalazłby
// tego, co zapisała karta.
//
// Odpowiedzi: `{ ok: true, wartosc }` albo `{ blad: '<komunikat dla człowieka>' }`. Komunikat wartości zaczyna
// się od nazwy parametru, bo hurt i karta pokazują kilka parametrów naraz.
//
// Brak wartości to `null` (warstwa bazy kasuje wtedy wiersz) — nigdy pusty napis.

export const LIMIT_PARAMETROW = 50;
export const TYPY_PARAMETROW = Object.freeze(['liczba', 'tekst', 'lista']);
export const LIMITY_PARAMETRU = Object.freeze({
  nazwa: 60,
  jednostka: 12,
  wartoscListy: 100,
  wartosciListy: 100,
  tekst: 200,
  miejscaPoPrzecinku: 3,
  // Więcej cyfr przed przecinkiem traci dokładność przy porównaniu `CAST(wartosc AS REAL)` w filtrze.
  cyfryCalkowite: 12,
});

/**
 * Nazwy pól stałych karty. Parametr o takiej nazwie stałby na karcie i w hurcie obok pola stałego o tej samej
 * nazwie — człowiek nie wiedziałby, które z nich wypełnić.
 */
export const NAZWY_POL_STALYCH = Object.freeze([
  'Szerokość',
  'Wysokość',
  'Głębokość',
  'Waga',
  'EAN',
  'Cena',
  'Cena zakupu',
  'Stawka VAT',
  'VAT',
  'Marka',
  'Kategoria',
  'SKU',
  'Nazwa',
]);

// Długość w znakach, nie w jednostkach UTF-16 — tak liczy `length()` w SQLite, którego CHECK jest drugą zaporą.
const dlugosc = (s) => [...s].length;
const zlozOdstepy = (s) => s.replace(/\s+/g, ' ').trim();
const naMale = (s) => s.toLocaleLowerCase('pl');

/** Klucz porównania nazw i wartości: przycięty, odstępy złożone, małe litery (także polskie). */
export function kluczNazwy(nazwa) {
  return naMale(zlozOdstepy(String(nazwa ?? '')));
}

const STALE = new Set(NAZWY_POL_STALYCH.map(kluczNazwy));

/**
 * Nazwa parametru: 1–60 znaków po przycięciu, inna niż pola stałe i niż `istniejaceNazwy` (porównanie bez
 * wielkości liter). Przy zmianie parametru wołający podaje nazwy POZOSTAŁYCH parametrów, bez jego własnej.
 */
export function walidujNazweParametru(nazwa, istniejaceNazwy = []) {
  const n = typeof nazwa === 'string' ? zlozOdstepy(nazwa) : '';
  if (!n) return { blad: 'Podaj nazwę parametru.' };
  if (dlugosc(n) > LIMITY_PARAMETRU.nazwa) {
    return { blad: `Nazwa parametru może mieć najwyżej ${LIMITY_PARAMETRU.nazwa} znaków.` };
  }
  const klucz = kluczNazwy(n);
  if (STALE.has(klucz)) {
    return { blad: `„${n}” to pole stałe karty — nazwij parametr inaczej.` };
  }
  if ((istniejaceNazwy ?? []).some((x) => kluczNazwy(x) === klucz)) {
    return { blad: `Parametr „${n}” już jest. Wybierz inną nazwę.` };
  }
  return { ok: true, wartosc: n };
}

// Wartości listy przed sprawdzeniem: przycięte, puste pominięte. Textarea (jedna na linię) albo tablica.
function surowaLista(wejscie) {
  const linie = Array.isArray(wejscie)
    ? wejscie.filter((x) => typeof x === 'string')
    : typeof wejscie === 'string'
      ? wejscie.split(/\r\n?|\n/)
      : [];
  return linie.map(zlozOdstepy).filter(Boolean);
}

function sprawdzListe(wartosci) {
  if (!wartosci.length) return { blad: 'Lista wyboru musi mieć co najmniej jedną wartość — wpisz po jednej w linii.' };
  if (wartosci.length > LIMITY_PARAMETRU.wartosciListy) {
    return { blad: `Lista wyboru może mieć najwyżej ${LIMITY_PARAMETRU.wartosciListy} wartości.` };
  }
  const widziane = new Set();
  for (const w of wartosci) {
    if (dlugosc(w) > LIMITY_PARAMETRU.wartoscListy) {
      return {
        blad: `Wartość „${w.slice(0, 30)}…” jest za długa — każda wartość listy może mieć najwyżej ${LIMITY_PARAMETRU.wartoscListy} znaków.`,
      };
    }
    const klucz = naMale(w);
    if (widziane.has(klucz)) return { blad: `Wartość „${w}” jest na liście dwa razy. Zostaw jedną.` };
    widziane.add(klucz);
  }
  return { ok: true, wartosc: wartosci };
}

/** Wartości listy z pola textarea (jedna na linię) albo z tablicy: 1–100 wartości po 1–100 znaków, bez powtórzeń. */
export function parsujWartosciListy(wejscie) {
  return sprawdzListe(surowaLista(wejscie));
}

/**
 * Zmiana nazwy wartości listy `z` → `na` na liście `wartosci` (już po edycji w textarea). Kolejność zostaje:
 * - `na` jest już na liście → `z` znika (połączenie dwóch wartości albo człowiek poprawił też textarea);
 * - inaczej `z` zamienia się na `na` w tym samym miejscu;
 * - nie ma ani `z`, ani `na` → `na` dochodzi na końcu (karty z `z` muszą mieć dokąd przejść).
 * Czy `z` było na liście przed zmianą, sprawdza warstwa bazy — tylko ona zna zapisaną definicję.
 */
export function zastosujZmianeNazwyWartosci(wartosci, z, na) {
  if (wartosci.includes(na)) return wartosci.filter((w) => w !== z || w === na);
  const i = wartosci.indexOf(z);
  if (i >= 0) return wartosci.map((w, n) => (n === i ? na : w));
  return [...wartosci, na];
}

const tekstPola = (w) => (typeof w === 'string' ? zlozOdstepy(w) : '');
const zaznaczone = (w) => w === true || w === 1 || ['1', 'on', 'tak', 'true'].includes(w);

function zmianaWartosci(dane) {
  const z = tekstPola(dane?.wartosc_z);
  const na = tekstPola(dane?.wartosc_na);
  if (!z && !na) return { ok: true, wartosc: null };
  if (!z) return { blad: 'Wybierz wartość, której nazwę zmieniasz.' };
  if (!na) return { blad: `Wpisz nową nazwę wartości „${z}”.` };
  return { ok: true, wartosc: z === na ? null : { z, na } };
}

/**
 * Definicja parametru z formularza Ustawień `{ nazwa, typ, jednostka, wartosci, wymagany, wartosc_z, wartosc_na }`.
 * Pola nieużywane przez typ są ignorowane (formularz bez JS wysyła wszystkie): jednostka tylko przy liczbie,
 * wartości listy i zmiana nazwy wartości tylko przy liście.
 *
 * @param {object} dane
 * @param {{ istniejaceNazwy?: string[], nowy?: boolean }} [opcje] `istniejaceNazwy` — nazwy pozostałych
 *   parametrów; `nowy` — dodawanie (wtedy pilnuje limitu {@link LIMIT_PARAMETROW})
 * @returns {{ ok: true, wartosc: { nazwa: string, typ: string, jednostka: string|null, wartosci: string[]|null,
 *   wymagany: boolean, zmianaWartosci: { z: string, na: string }|null } } | { blad: string }}
 */
export function walidujDefinicje(dane, { istniejaceNazwy = [], nowy = false } = {}) {
  if (nowy && (istniejaceNazwy?.length ?? 0) >= LIMIT_PARAMETROW) {
    return {
      blad: `Firma może mieć najwyżej ${LIMIT_PARAMETROW} parametrów kart. Usuń nieużywany, żeby dodać nowy.`,
    };
  }
  const nazwa = walidujNazweParametru(dane?.nazwa, istniejaceNazwy);
  if (nazwa.blad) return nazwa;
  const typ = dane?.typ;
  if (typeof typ !== 'string' || !TYPY_PARAMETROW.includes(typ)) {
    return { blad: 'Wybierz typ parametru: liczba, tekst albo lista wyboru.' };
  }

  let jednostka = null;
  if (typ === 'liczba') {
    jednostka = tekstPola(dane?.jednostka) || null;
    if (jednostka && dlugosc(jednostka) > LIMITY_PARAMETRU.jednostka) {
      return { blad: `Jednostka może mieć najwyżej ${LIMITY_PARAMETRU.jednostka} znaków (np. W, cm, kg).` };
    }
  }

  let wartosci = null;
  let zmiana = null;
  if (typ === 'lista') {
    const zm = zmianaWartosci(dane);
    if (zm.blad) return zm;
    zmiana = zm.wartosc;
    const surowe = surowaLista(dane?.wartosci);
    const lista = sprawdzListe(zmiana ? zastosujZmianeNazwyWartosci(surowe, zmiana.z, zmiana.na) : surowe);
    if (lista.blad) return lista;
    wartosci = lista.wartosc;
  }

  return {
    ok: true,
    wartosc: {
      nazwa: nazwa.wartosc,
      typ,
      jednostka,
      wartosci,
      wymagany: zaznaczone(dane?.wymagany),
      zmianaWartosci: zmiana,
    },
  };
}

const LICZBA = /^(\d+)(?:[.,](\d+))?$/;

function liczba(parametr, t) {
  const bezOdstepow = t.replace(/\s/g, '');
  if (/^-/.test(bezOdstepow) && LICZBA.test(bezOdstepow.slice(1))) {
    return { blad: `${parametr.nazwa}: wartość nie może być ujemna.` };
  }
  const m = LICZBA.exec(bezOdstepow);
  if (!m) return { blad: `${parametr.nazwa}: „${t}” to nie jest liczba. Wpisz np. 12,5.` };
  const calkowite = m[1].replace(/^0+(?=\d)/, '');
  const ulamek = (m[2] ?? '').replace(/0+$/, '');
  if (ulamek.length > LIMITY_PARAMETRU.miejscaPoPrzecinku) {
    return { blad: `${parametr.nazwa}: „${t}” — najwyżej trzy miejsca po przecinku.` };
  }
  if (calkowite.length > LIMITY_PARAMETRU.cyfryCalkowite) {
    return { blad: `${parametr.nazwa}: liczba „${t}” jest za duża.` };
  }
  return { ok: true, wartosc: ulamek ? `${calkowite}.${ulamek}` : calkowite };
}

function zListy(parametr, t) {
  const lista = Array.isArray(parametr.wartosci) ? parametr.wartosci : [];
  const dokladna = lista.find((w) => w === t);
  if (dokladna !== undefined) return { ok: true, wartosc: dokladna };
  const klucz = naMale(t);
  const podobna = lista.find((w) => naMale(w) === klucz);
  if (podobna !== undefined) return { ok: true, wartosc: podobna };
  const pokaz = lista.length > 10 ? `${lista.slice(0, 10).join(', ')}, …` : lista.join(', ');
  return { blad: `${parametr.nazwa}: „${t}” nie ma na liście. Wybierz jedną z wartości: ${pokaz}.` };
}

/**
 * Wartość parametru po normalizacji wg typu: `{ ok: true, wartosc }`, gdzie `wartosc` to napis do zapisu
 * albo `null` (puste pole = brak wartości), albo `{ blad }`.
 * - liczba: przecinek i kropka, odstępy tysięcy pomijane, ≥ 0, najwyżej 3 miejsca po przecinku; zapis
 *   kanoniczny z kropką i bez zer końcowych (`12.5`, `40`) — filtr porównuje `CAST(wartosc AS REAL)`;
 * - tekst: przycięty, odstępy złożone, najwyżej 200 znaków;
 * - lista: tylko wartość z `parametr.wartosci`; wielkość liter dopasowana do wpisu z listy.
 *
 * @param {{ nazwa: string, typ: string, wartosci?: string[]|null }} parametr definicja (jak z warstwy bazy)
 * @param {unknown} surowa wartość z formularza
 */
export function normalizujWartosc(parametr, surowa) {
  // Pole przysłane dwa razy (Fastify oddaje tablicę) to nie „puste” — nie zgadujemy, którą wartość wybrać.
  if (Array.isArray(surowa)) return { blad: `${parametr.nazwa}: wartość przyszła dwa razy — nie wiem, którą wybrać.` };
  const t = surowa === null || surowa === undefined ? '' : zlozOdstepy(String(surowa));
  if (!t) return { ok: true, wartosc: null };
  if (parametr.typ === 'liczba') return liczba(parametr, t);
  if (parametr.typ === 'lista') return zListy(parametr, t);
  if (parametr.typ === 'tekst') {
    if (dlugosc(t) > LIMITY_PARAMETRU.tekst) {
      return { blad: `${parametr.nazwa}: tekst może mieć najwyżej ${LIMITY_PARAMETRU.tekst} znaków.` };
    }
    return { ok: true, wartosc: t };
  }
  return { blad: `${parametr.nazwa}: nieznany typ parametru „${String(parametr.typ)}”.` };
}
