// Producenci (GPSR): walidacja danych producenta i wybór producenta karty. Czyste funkcje, bez bazy.
//
// Przepisy wymagają nazwy, adresu pocztowego i adresu elektronicznego (e-mail albo strona www). Walidacja
// jest tu w jednym miejscu dla formularza, zapisu w bazie i każdego przyszłego importu; CHECK-i w bazie są
// drugą zaporą, nie pierwszą.

export const LIMITY_PRODUCENTA = Object.freeze({ nazwa: 200, adres: 500, email: 254, www: 500 });

const KOMUNIKATY = Object.freeze({
  nazwa: 'Podaj nazwę producenta',
  adres: 'Podaj adres pocztowy producenta',
  kontakt: 'Podaj e-mail albo stronę www producenta — przepisy GPSR wymagają adresu elektronicznego',
  email: 'E-mail producenta wygląda na niepełny — potrzebny jest znak @ i domena z kropką',
  www: 'Strona www producenta musi być adresem http:// albo https://',
});

const zaDlugie = (pole) =>
  `${{ nazwa: 'Nazwa', adres: 'Adres', email: 'E-mail', www: 'Strona www' }[pole]} producenta może mieć najwyżej ${LIMITY_PRODUCENTA[pole]} znaków`;

// Pole formularza przychodzi jako tekst; tablica (pole podane dwa razy) albo liczba to brak wartości.
const tekst = (w) => (typeof w === 'string' ? w.replace(/\r\n?/g, '\n').trim() : '');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Schemat to litery przed dwukropkiem; dwukropek z cyframi po nim to port („sklep.example:8080”), nie schemat.
const SCHEMAT = /^([a-z][a-z0-9+.-]*):(?!\d)/i;

function normalizujWww(wartosc) {
  const zSchematem = SCHEMAT.test(wartosc) ? wartosc : `https://${wartosc}`;
  if (/\s/.test(zSchematem)) return null;
  let url;
  try {
    url = new URL(zSchematem);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return null;
  return zSchematem;
}

/**
 * Sprawdza dane producenta `{ nazwa, adres, email, www }`. Oddaje `{ ok, bledy: { pole: tekst }, wartosci }`;
 * `wartosci` są po `trim`, puste e-mail i www to `null`, strona bez schematu dostaje `https://`.
 * Brak obu adresów elektronicznych to błąd pola `email` (formularz pokazuje go przy e-mailu).
 */
export function walidujProducenta(dane = {}) {
  const nazwa = tekst(dane?.nazwa);
  const adres = tekst(dane?.adres);
  const email = tekst(dane?.email) || null;
  const wwwWpis = tekst(dane?.www) || null;
  const bledy = {};

  if (!nazwa) bledy.nazwa = KOMUNIKATY.nazwa;
  else if (nazwa.length > LIMITY_PRODUCENTA.nazwa) bledy.nazwa = zaDlugie('nazwa');

  if (!adres) bledy.adres = KOMUNIKATY.adres;
  else if (adres.length > LIMITY_PRODUCENTA.adres) bledy.adres = zaDlugie('adres');

  if (email) {
    if (email.length > LIMITY_PRODUCENTA.email) bledy.email = zaDlugie('email');
    else if (!EMAIL.test(email)) bledy.email = KOMUNIKATY.email;
  }

  let www = wwwWpis;
  if (wwwWpis) {
    www = normalizujWww(wwwWpis);
    if (!www) bledy.www = KOMUNIKATY.www;
    else if (www.length > LIMITY_PRODUCENTA.www) bledy.www = zaDlugie('www');
  }

  if (!email && !wwwWpis) bledy.email = KOMUNIKATY.kontakt;

  return {
    ok: Object.keys(bledy).length === 0,
    bledy,
    wartosci: { nazwa, adres, email, www: www ?? wwwWpis },
  };
}

/** Jedna linia „nazwa, adres” — adres wielowierszowy zlewa się przecinkami. */
export function opisProducenta(producent) {
  if (!producent) return '';
  const adres = String(producent.adres ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(', ');
  return [producent.nazwa, adres].filter(Boolean).join(', ');
}

const idPrzypisania = (przypisania, marka) =>
  przypisania instanceof Map
    ? przypisania.get(marka)
    : przypisania && Object.hasOwn(przypisania, marka)
      ? przypisania[marka]
      : undefined;

/**
 * Producent karty: marka z przypisanym producentem → ten producent; inaczej producent domyślny; inaczej brak
 * ze wskazówką, co uzupełnić. `przypisania` — `Map` (albo obiekt) marka → id producenta, `producenci` — lista
 * producentów z `id`, `domyslny` — producent domyślny albo `null`.
 * Wynik: `{ producent, zrodlo: 'marka'|'domyslny'|'brak', marka?, dopisek?, brak? }`.
 */
export function producentKarty({ karta, przypisania, producenci, domyslny }) {
  const marka = typeof karta?.marka === 'string' ? karta.marka.trim() : '';
  if (marka) {
    const id = idPrzypisania(przypisania, marka);
    const producent = id == null ? null : ((producenci ?? []).find((p) => String(p.id) === String(id)) ?? null);
    if (producent) return { producent, zrodlo: 'marka', marka };
    if (domyslny) {
      return {
        producent: domyslny,
        zrodlo: 'domyslny',
        marka,
        dopisek: `marka ${marka} nie ma producenta — użyto domyślnego`,
      };
    }
    return { producent: null, zrodlo: 'brak', marka, brak: `Przypisz producenta marce ${marka}` };
  }
  if (domyslny) return { producent: domyslny, zrodlo: 'domyslny' };
  return { producent: null, zrodlo: 'brak', brak: 'Wskaż producenta domyślnego' };
}
