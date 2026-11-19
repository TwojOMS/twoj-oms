// Producenci (GPSR): walidacja danych producenta i wybór producenta karty. Czyste funkcje, bez bazy.
//
// Przepisy wymagają nazwy, adresu pocztowego i adresu elektronicznego (e-mail albo strona www). Walidacja
// jest tu w jednym miejscu dla formularza, zapisu w bazie i każdego przyszłego importu; CHECK-i w bazie są
// drugą zaporą, nie pierwszą.
//
// Adres pocztowy przychodzi w polach (ulica, kod, miejscowość, kraj), a kolumnę `adres` składa domena: z niej
// czytają opis producenta, karta GPSR i lista, więc ci czytelnicy nie muszą znać pól. Kraj jest w złożonym
// adresie zawsze, także Polska — kupujący z innego państwa UE ma dostać adres pełny.

export const LIMITY_PRODUCENTA = Object.freeze({
  nazwa: 200,
  adres: 500,
  ulica: 200,
  kod: 12,
  miasto: 100,
  email: 254,
  www: 500,
});

// Kody ISO 3166-1 (Grecja to GR — nie prefiks VAT EL). Nazwy z Intl, posortowane po polsku, żeby lista w formularzu
// i nazwa w złożonym adresie pochodziły z jednego miejsca.
const UE = 'AT BE BG CY CZ DE DK EE ES FI FR GR HR HU IE IT LT LU LV MT NL PT RO SE SI SK';
const SPOZA_UE = 'CH CN GB IN JP KR NO TR TW UA US VN';
const nazwaRegionu = new Intl.DisplayNames(['pl'], { type: 'region' });
const kolejnosc = new Intl.Collator('pl');
const kraje = (kody, ue) =>
  kody
    .split(' ')
    .map((kod) => Object.freeze({ kod, nazwa: nazwaRegionu.of(kod), ue }))
    .sort((a, b) => kolejnosc.compare(a.nazwa, b.nazwa));

/** Kraje do wyboru: Polska, potem pozostałe państwa UE, potem spoza UE (`ue: false`). */
export const KRAJE_PRODUCENTA = Object.freeze([
  Object.freeze({ kod: 'PL', nazwa: nazwaRegionu.of('PL'), ue: true }),
  ...kraje(UE, true),
  ...kraje(SPOZA_UE, false),
]);

const KOMUNIKATY = Object.freeze({
  nazwa: 'Podaj nazwę producenta',
  ulica: 'Podaj ulicę i numer',
  kod: 'Podaj kod pocztowy',
  kodPL: 'Kod pocztowy w Polsce ma postać 00-000',
  kodInny: 'Kod pocztowy może mieć tylko litery, cyfry, spację i kreskę',
  miasto: 'Podaj miejscowość',
  kraj: 'Wybierz kraj z listy',
  kontakt: 'Podaj e-mail albo stronę www producenta — przepisy GPSR wymagają adresu elektronicznego',
  email: 'E-mail producenta wygląda na niepełny — potrzebny jest znak @ i domena z kropką',
  www: 'Strona www producenta musi być adresem http:// albo https://',
});

const zaDlugie = (pole) =>
  `${{ nazwa: 'Nazwa', ulica: 'Ulica i numer', miasto: 'Miejscowość', email: 'E-mail', www: 'Strona www' }[pole]} producenta może mieć najwyżej ${LIMITY_PRODUCENTA[pole]} znaków`;

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

const KOD_PL = /^(\d{2})-?(\d{3})$/;
const KOD_INNY = /^[A-Za-z0-9 -]{2,12}$/;

/** Kod pocztowy po kraju: `{ kod }` w postaci do zapisu albo `{ blad }`. */
function kodPocztowy(wpis, kraj) {
  if (!wpis) return { blad: KOMUNIKATY.kod };
  if (kraj === 'PL') {
    const m = KOD_PL.exec(wpis);
    return m ? { kod: `${m[1]}-${m[2]}` } : { blad: KOMUNIKATY.kodPL };
  }
  return KOD_INNY.test(wpis) ? { kod: wpis.toUpperCase() } : { blad: KOMUNIKATY.kodInny };
}

/**
 * Sprawdza dane producenta `{ nazwa, ulica, kod, miasto, kraj, email, www }`. Oddaje
 * `{ ok, bledy: { pole: tekst }, wartosci }`; `wartosci` są po `trim`, kraj pusty to `PL`, polski kod ma kreskę,
 * zagraniczny — wielkie litery, puste e-mail i www to `null`, strona bez schematu dostaje `https://`.
 * `wartosci.adres` to adres złożony z pól (ulica / kod miejscowość / kraj) — pusty, gdy pola mają błędy. Samo
 * pole `adres` na wejściu niczego nie zastępuje: brak pól adresu to błędy przy polach.
 * Brak obu adresów elektronicznych to błąd pola `email` (formularz pokazuje go przy e-mailu).
 */
export function walidujProducenta(dane = {}) {
  const nazwa = tekst(dane?.nazwa);
  const ulica = tekst(dane?.ulica);
  const kodWpis = tekst(dane?.kod);
  const miasto = tekst(dane?.miasto);
  const kraj = tekst(dane?.kraj).toUpperCase() || 'PL';
  const email = tekst(dane?.email) || null;
  const wwwWpis = tekst(dane?.www) || null;
  const bledy = {};

  if (!nazwa) bledy.nazwa = KOMUNIKATY.nazwa;
  else if (nazwa.length > LIMITY_PRODUCENTA.nazwa) bledy.nazwa = zaDlugie('nazwa');

  if (!ulica) bledy.ulica = KOMUNIKATY.ulica;
  else if (ulica.length > LIMITY_PRODUCENTA.ulica) bledy.ulica = zaDlugie('ulica');

  const krajZListy = KRAJE_PRODUCENTA.find((k) => k.kod === kraj) ?? null;
  const kod = kodPocztowy(kodWpis, kraj);
  if (kod.blad) bledy.kod = kod.blad;

  if (!miasto) bledy.miasto = KOMUNIKATY.miasto;
  else if (miasto.length > LIMITY_PRODUCENTA.miasto) bledy.miasto = zaDlugie('miasto');

  if (!krajZListy) bledy.kraj = KOMUNIKATY.kraj;

  const adresPoprawny = !bledy.ulica && !bledy.kod && !bledy.miasto && krajZListy;
  const adres = adresPoprawny ? `${ulica}\n${kod.kod} ${miasto}\n${krajZListy.nazwa}` : '';

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
    wartosci: { nazwa, ulica, kod: kod.kod ?? kodWpis, miasto, kraj, adres, email, www: www ?? wwwWpis },
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
