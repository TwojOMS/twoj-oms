// Cennik dostaw dobierany do rozmiaru produktu.
// Reguły konta: [{ doMm: [a,b,c], doG: w, cennik, nazwaOms? }, …, { cennik, nazwaOms? }] — sprawdzane od góry,
// pierwsza pasująca wygrywa, ostatni wpis bez limitów to cennik domyślny („dla większych”). Jeden wpis bez limitów to
// reguła „wszystko”. Kod nie zna żadnych gabarytów przewoźników — limity wpisuje sprzedawca.
import { centymetryZMilimetrow, gramyZKilogramow, kilogramyZGramow, milimetryZCentymetrow } from './rozmiar.js';

export const TEKST_BRAK_WYMIAROW =
  'Brak wymiarów/wagi — OMS nie wie, czy produkt zmieści się w paczkomacie. ' +
  'Uzupełnij wymiary albo ustaw cennik na karcie.';
export const TEKST_BRAK_CENNIKA = 'Konto nie ma powiązanego cennika dostaw — ustaw powiązanie w Magazyn → Cenniki.';
export const TEKST_BRAK_DOMYSLNEGO =
  'Produkt jest większy od cenników rozmiaru, a cennik domyślny nie ma powiązania z tym kontem — ' +
  'ustaw je w Magazyn → Cenniki.';

const napis = (v) => (typeof v === 'string' ? v.trim() : '');
const dodatnia = (v) => (Number.isInteger(v) && v > 0 ? v : null);
const malejaco = (a, b) => b - a;
const przecinek = (s) => String(s).replace('.', ',');

// Lista z bazy bez sprawdzenia (zapis przez API, ręczna zmiana): pusty cennik albo reguła bez limitów w środku
// znaczą „konto bez cennika” — odmowa zamiast oferty z pustym cennikiem albo wyjątku przy doborze.
const regulyCale = (lista) =>
  lista.every(
    (r, i) =>
      napis(r?.cennik) &&
      (i === lista.length - 1 ||
        (Array.isArray(r.doMm) && r.doMm.length === 3 && r.doMm.every(dodatnia) && dodatnia(r.doG))),
  );

/** Reguły konta: lista `cenniki`, a gdy jej brak — dawne pole tekstowe jako jedna reguła „wszystko”. */
export function regulyKonta(ustawienia) {
  if (Array.isArray(ustawienia?.cenniki)) return regulyCale(ustawienia.cenniki) ? ustawienia.cenniki : [];
  const stary = napis(ustawienia?.cennikDostaw);
  return stary ? [{ cennik: stary }] : [];
}

const limityPoprawne = (r) =>
  Array.isArray(r?.doMm) && r.doMm.length === 3 && r.doMm.every((v) => dodatnia(v) != null) && dodatnia(r.doG) != null;

/** Limity cennika rozmiaru jako napis „do 64×38×8 cm, 25 kg” (powód doboru i etykieta pola wyboru). */
export const opisRozmiaruCennika = (r) => {
  const wymiary = r.doMm.map((mm) => przecinek(centymetryZMilimetrow(mm))).join('×');
  return `do ${wymiary} cm, ${przecinek(kilogramyZGramow(r.doG))} kg`;
};
const cmKg = opisRozmiaruCennika;

// Reguły z cenników OMS niosą nazwę cennika — powód pokazuje ją sprzedawcy; lista bez nazw (dawny zapis) zostaje
// przy dawnych napisach.
function tekstReguly(numer, r) {
  return napis(r.nazwaOms) ? `cennik OMS „${napis(r.nazwaOms)}” (${cmKg(r)})` : `reguła ${numer}: ${cmKg(r)}`;
}
const tekstDomyslnego = (r, dawny) => (napis(r.nazwaOms) ? `cennik OMS „${napis(r.nazwaOms)}”` : dawny);

function cennikZRegul(karta, reguly) {
  const lista = Array.isArray(reguly) ? reguly : [];
  if (!lista.length) return { odmowa: { kod: 'brak-cennika', tekst: TEKST_BRAK_CENNIKA } };
  // Ostatni wpis bez limitów to cennik domyślny. Konto może mieć same cenniki rozmiaru, gdy domyślny nie jest z nim
  // powiązany — wtedy produkt większy od wszystkich dostaje odmowę zamiast cudzego cennika.
  const domyslny = limityPoprawne(lista[lista.length - 1]) ? null : lista[lista.length - 1];
  const rozmiarowe = domyslny ? lista.slice(0, -1) : lista;
  if (domyslny && !rozmiarowe.length)
    return {
      cennik: napis(domyslny.cennik),
      powod: { rodzaj: 'wszystko', tekst: tekstDomyslnego(domyslny, 'cennik domyślny konta') },
    };
  const k = karta ?? {};
  const wymiary = [k.szerokosc_mm, k.wysokosc_mm, k.glebokosc_mm].map((v) => dodatnia(Number(v ?? NaN)));
  const waga = dodatnia(Number(k.waga_g ?? NaN));
  if (wymiary.includes(null) || waga == null) return { odmowa: { kod: 'brak-wymiarow', tekst: TEKST_BRAK_WYMIAROW } };
  const obrocone = [...wymiary].sort(malejaco);
  for (let i = 0; i < rozmiarowe.length; i += 1) {
    const r = rozmiarowe[i];
    const limity = [...r.doMm].sort(malejaco);
    if (obrocone.every((x, j) => x <= limity[j]) && waga <= r.doG) {
      return { cennik: napis(r.cennik), powod: { rodzaj: 'regula', numer: i + 1, tekst: tekstReguly(i + 1, r) } };
    }
  }
  if (!domyslny) return { odmowa: { kod: 'brak-domyslnego', tekst: TEKST_BRAK_DOMYSLNEGO } };
  return {
    cennik: napis(domyslny.cennik),
    powod: {
      rodzaj: 'wieksze',
      tekst: tekstDomyslnego(domyslny, 'cennik domyślny — produkt większy od wierszy rozmiaru'),
    },
  };
}

/**
 * Dobór cennika dla karty. Kolejność: wyjątek na karcie → pusta lista → jedna reguła „wszystko” →
 * brak wymiarów/wagi → pierwsza pasująca reguła → „dla większych” (albo odmowa, gdy konto nie ma domyślnego).
 * `nazwaWyjatku` — nazwa cennika OMS karty do powodu.
 * Zwraca `{ cennik, powod: { rodzaj, numer?, tekst } }` albo `{ odmowa: { kod, tekst } }`.
 */
export function dobierzCennik({ karta, reguly, wyjatek, nazwaWyjatku } = {}) {
  const tekst = napis(nazwaWyjatku) ? `wyjątek na karcie: cennik OMS „${napis(nazwaWyjatku)}”` : 'wyjątek na karcie';
  const zWyjatku = napis(wyjatek) ? { cennik: napis(wyjatek), powod: { rodzaj: 'wyjatek', tekst } } : null;
  return zWyjatku ?? cennikZRegul(karta, reguly);
}

/** Walidacja listy do zapisu. Pusta lista jest dozwolona (konto bez cennika). Zwraca `{ reguly, bledy: string[] }`. */
export function sprawdzReguly(reguly) {
  if (!Array.isArray(reguly)) return { reguly: [], bledy: ['Reguły cenników muszą być listą.'] };
  const bledy = [];
  reguly.forEach((r, i) => {
    const nr = i + 1;
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      bledy.push(`Reguła ${nr}: zły zapis.`);
      return;
    }
    if (!napis(r.cennik)) bledy.push(`Reguła ${nr}: brak cennika.`);
    const ostatnia = i === reguly.length - 1;
    if (ostatnia) {
      if (r.doMm != null || r.doG != null)
        bledy.push('Ostatnia reguła to cennik domyślny — bez limitów wymiarów i wagi.');
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
    if (mm.includes(null) || g == null)
      bledy.push({ wiersz: i, tekst: 'Podaj trzy wymiary w cm i wagę w kg (liczby większe od zera).' });
    else if (!cennik) bledy.push({ wiersz: i, tekst: 'Podaj cennik dla tego wiersza.' });
    else reguly.push({ doMm: mm, doG: g, cennik });
  });
  const wieksze = napis(dlaWiekszych);
  if (wieksze) reguly.push({ cennik: wieksze });
  else if (reguly.length || bledy.length)
    bledy.push({ wiersz: null, tekst: 'Wybierz cennik domyślny — obowiązkowy, gdy są wiersze rozmiaru.' });
  return { reguly: bledy.length ? [] : reguly, bledy };
}
