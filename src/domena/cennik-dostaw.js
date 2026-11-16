// Cennik dostaw dobierany do rozmiaru produktu.
// Reguły konta: [{ doMm: [a,b,c], doG: w, cennik }, …, { cennik }] — sprawdzane od góry, pierwsza pasująca wygrywa,
// ostatni wpis bez limitów to „dla większych”. Jeden wpis bez limitów to reguła „wszystko” (jak dawne pole tekstowe).
// Kod nie zna żadnych gabarytów przewoźników — limity wpisuje sprzedawca.
import { centymetryZMilimetrow, gramyZKilogramow, kilogramyZGramow, milimetryZCentymetrow } from './rozmiar.js';

export const TEKST_BRAK_WYMIAROW = 'Brak wymiarów/wagi — OMS nie wie, czy produkt zmieści się w paczkomacie. '
  + 'Uzupełnij wymiary albo ustaw cennik na karcie.';
export const TEKST_BRAK_CENNIKA = 'Konto nie ma ustawionego cennika dostaw.';

const napis = (v) => (typeof v === 'string' ? v.trim() : '');
const dodatnia = (v) => (Number.isInteger(v) && v > 0 ? v : null);
const malejaco = (a, b) => b - a;
const przecinek = (s) => String(s).replace('.', ',');

// Lista z bazy bez sprawdzenia (zapis przez API, ręczna zmiana): pusty cennik albo reguła bez limitów w środku
// znaczą „konto bez cennika” — odmowa zamiast oferty z pustym cennikiem albo wyjątku przy doborze.
const regulyCale = (lista) => lista.every((r, i) => napis(r?.cennik) && (i === lista.length - 1
  || (Array.isArray(r.doMm) && r.doMm.length === 3 && r.doMm.every(dodatnia) && dodatnia(r.doG))));

/** Reguły konta: lista `cenniki`, a gdy jej brak — dawne pole tekstowe jako jedna reguła „wszystko”. */
export function regulyKonta(ustawienia) {
  if (Array.isArray(ustawienia?.cenniki)) return regulyCale(ustawienia.cenniki) ? ustawienia.cenniki : [];
  const stary = napis(ustawienia?.cennikDostaw);
  return stary ? [{ cennik: stary }] : [];
}

function tekstReguly(numer, r) {
  const wymiary = r.doMm.map((mm) => przecinek(centymetryZMilimetrow(mm))).join('×');
  return `reguła ${numer}: do ${wymiary} cm, ${przecinek(kilogramyZGramow(r.doG))} kg`;
}

function cennikZRegul(karta, reguly) {
  const lista = Array.isArray(reguly) ? reguly : [];
  if (!lista.length) return { odmowa: { kod: 'brak-cennika', tekst: TEKST_BRAK_CENNIKA } };
  if (lista.length === 1) return { cennik: napis(lista[0].cennik), powod: { rodzaj: 'wszystko', tekst: 'jeden cennik konta' } };
  const k = karta ?? {};
  const wymiary = [k.szerokosc_mm, k.wysokosc_mm, k.glebokosc_mm].map((v) => dodatnia(Number(v ?? NaN)));
  const waga = dodatnia(Number(k.waga_g ?? NaN));
  if (wymiary.includes(null) || waga == null) return { odmowa: { kod: 'brak-wymiarow', tekst: TEKST_BRAK_WYMIAROW } };
  const obrocone = [...wymiary].sort(malejaco);
  for (let i = 0; i < lista.length - 1; i += 1) {
    const r = lista[i];
    const limity = [...r.doMm].sort(malejaco);
    if (obrocone.every((x, j) => x <= limity[j]) && waga <= r.doG) {
      return { cennik: napis(r.cennik), powod: { rodzaj: 'regula', numer: i + 1, tekst: tekstReguly(i + 1, r) } };
    }
  }
  return { cennik: napis(lista[lista.length - 1].cennik), powod: { rodzaj: 'wieksze', tekst: 'dla większych' } };
}

/**
 * Dobór cennika dla karty. Kolejność: wyjątek na karcie → pusta lista → jedna reguła „wszystko” →
 * brak wymiarów/wagi → pierwsza pasująca reguła → „dla większych”.
 * Zwraca `{ cennik, powod: { rodzaj, numer?, tekst } }` albo `{ odmowa: { kod, tekst } }`.
 */
export function dobierzCennik({ karta, reguly, wyjatek } = {}) {
  const zWyjatku = napis(wyjatek) ? { cennik: napis(wyjatek), powod: { rodzaj: 'wyjatek', tekst: 'wyjątek na karcie' } } : null;
  return zWyjatku ?? cennikZRegul(karta, reguly);
}

const limityPoprawne = (r) => Array.isArray(r.doMm) && r.doMm.length === 3 && r.doMm.every((v) => dodatnia(v) != null)
  && dodatnia(r.doG) != null;

/** Walidacja listy do zapisu. Pusta lista jest dozwolona (konto bez cennika). Zwraca `{ reguly, bledy: string[] }`. */
export function sprawdzReguly(reguly) {
  if (!Array.isArray(reguly)) return { reguly: [], bledy: ['Reguły cenników muszą być listą.'] };
  const bledy = [];
  reguly.forEach((r, i) => {
    const nr = i + 1;
    if (!r || typeof r !== 'object' || Array.isArray(r)) { bledy.push(`Reguła ${nr}: zły zapis.`); return; }
    if (!napis(r.cennik)) bledy.push(`Reguła ${nr}: brak cennika.`);
    const ostatnia = i === reguly.length - 1;
    if (ostatnia) {
      if (r.doMm != null || r.doG != null) bledy.push('Ostatnia reguła to cennik dla większych — bez limitów wymiarów i wagi.');
    } else if (!limityPoprawne(r)) {
      bledy.push(`Reguła ${nr}: podaj trzy wymiary i wagę (liczby większe od zera).`);
    }
  });
  return { reguly, bledy };
}

/**
 * Wiersze formularza (cm i kg jako tekst, przecinek dozwolony) → reguły w mm i g plus „dla większych” na końcu.
 * Pusty wiersz jest pomijany. Błędy: `{ wiersz: indeks | null, tekst }` (null = pole „dla większych”).
 */
export function regulyZFormularza(wiersze, dlaWiekszych) {
  const reguly = [];
  const bledy = [];
  (Array.isArray(wiersze) ? wiersze : []).forEach((w, i) => {
    const pola = [w?.a, w?.b, w?.c, w?.waga, w?.cennik].map((v) => (typeof v === 'string' ? v : ''));
    if (pola.every((v) => !v.trim())) return;
    const mm = pola.slice(0, 3).map((v) => milimetryZCentymetrow(v)?.mm ?? null);
    const g = gramyZKilogramow(pola[3])?.g ?? null;
    const cennik = pola[4].trim();
    if (mm.includes(null) || g == null) bledy.push({ wiersz: i, tekst: 'Podaj trzy wymiary w cm i wagę w kg (liczby większe od zera).' });
    else if (!cennik) bledy.push({ wiersz: i, tekst: 'Podaj cennik dla tego wiersza.' });
    else reguly.push({ doMm: mm, doG: g, cennik });
  });
  const wieksze = napis(dlaWiekszych);
  if (wieksze) reguly.push({ cennik: wieksze });
  else if (reguly.length || bledy.length) bledy.push({ wiersz: null, tekst: 'Podaj cennik dla większych — obowiązkowy, gdy są reguły rozmiaru.' });
  return { reguly: bledy.length ? [] : reguly, bledy };
}
