import { PROG_BEZ_RUCHU_DNI_ROBOCZYCH } from './etap-przesylki.js';
import { DNI_UPRZEDZENIA } from './kanal-stan.js';

// Kolejność tabelki i lista osobistych ustawień mają jedno źródło. Progi w opisach pochodzą ze stałych reguł,
// żeby opis nie rozjechał się z tym, co reguła naprawdę liczy.
export const RODZAJE_OSTRZEZEN = Object.freeze(
  [
    // Martwy kanał to brak nowych zamówień — tego nikt nie może wyłączyć u siebie.
    {
      typ: 'kanal',
      nazwa: 'Kanały sprzedaży — awaria albo wygasające połączenie',
      opis: `Kanał przestał pobierać zamówienia albo jego połączenie wygaśnie w ciągu ${DNI_UPRZEDZENIA} dni. Tego rodzaju nie da się wyłączyć.`,
      zawsze: true,
    },
    {
      typ: 'integracja',
      nazwa: 'Awarie integracji',
      opis: 'Sklep, usługa albo zadanie w tle nie działa lub od dawna nie kończy przebiegu.',
    },
    // Widzi tylko administrator (reguły edytuje wyłącznie on).
    {
      typ: 'automatyzacja',
      nazwa: 'Automatyzacje wstrzymane lub niepewne',
      opis: 'Reguła wstrzymana bezpiecznikiem albo mail do kupującego, o którym nie wiadomo, czy wyszedł (tylko administrator).',
      tylkoAdmin: true,
    },
    {
      typ: 'faktura-ksef',
      nazwa: 'Faktury niewysłane do KSeF',
      opis: 'Dokument wystawiony przed dziś nie ma numeru KSeF.',
    },
    {
      typ: 'faktura-termin',
      nazwa: 'Faktury po terminie płatności',
      opis: 'Pozostała kwota do zapłaty, a termin płatności faktury już minął.',
    },
    {
      typ: 'pobranie-korekta',
      nazwa: 'Pobrania czekające na korektę',
      opis: 'Paczka za pobraniem wróciła bez gotówki, a faktura czeka na korektę do zera.',
    },
    {
      typ: 'zwrot-korekta',
      nazwa: 'Zwroty czekające na korektę',
      opis: 'Zwrot zarejestrowany przed dziś ma fakturę, ale nie ma korekty w inFakcie.',
    },
    {
      typ: 'przesylka',
      nazwa: 'Przesyłki bez ruchu',
      opis: `Przesyłka od ponad ${PROG_BEZ_RUCHU_DNI_ROBOCZYCH} dni robocze nie zmieniła statusu u kuriera.`,
    },
    {
      typ: 'niski-stan',
      nazwa: 'Niski stan magazynowy',
      opis: 'Stan co najmniej jednej aktywnej karty jest równy ustawionemu progowi lub niższy.',
    },
  ].map((r) => Object.freeze(r)),
);

export const KOLEJNOSC = Object.freeze(RODZAJE_OSTRZEZEN.map((r) => r.typ));

const DO_UKRYCIA = Object.freeze(RODZAJE_OSTRZEZEN.filter((r) => !r.zawsze).map((r) => r.typ));

/** Rodzaje, które konto w ogóle może zobaczyć (`tylkoAdmin` — tylko administrator) — lista na ekranie. */
export function rodzajeDlaKonta(konto) {
  return RODZAJE_OSTRZEZEN.filter((r) => !r.tylkoAdmin || konto?.admin === true);
}

/** Czy rodzaj widzi tylko administrator. Nieznany rodzaj — nie (na braku danych nie chowamy). */
export function tylkoDlaAdmina(typ) {
  return RODZAJE_OSTRZEZEN.some((r) => r.typ === typ && r.tylkoAdmin === true);
}

/** Czy rodzaju nie da się ukryć osobistym ustawieniem. */
export function zawszeWidoczny(typ) {
  return RODZAJE_OSTRZEZEN.some((r) => r.typ === typ && r.zawsze === true);
}

/** Walidacja ZAPISU z formularza: nieznany albo nie do ukrycia rodzaj to błąd wołającego. */
export function sprawdzUkryteTypy(typy) {
  if (!Array.isArray(typy) || typy.some((typ) => !DO_UKRYCIA.includes(typ))) {
    throw new Error('Wybierz wyłącznie znane rodzaje ostrzeżeń.');
  }
  return [...new Set(typy)];
}

/**
 * ODCZYT zapisanych ukryć: rodzaj usunięty z programu albo nie do ukrycia po prostu odpada, reszta wyboru konta
 * zostaje — wyjątek tutaj kasowałby wszystkie ukrycia konta po każdym usunięciu rodzaju.
 */
export function oczyscUkryteTypy(typy) {
  if (!Array.isArray(typy)) return [];
  return [...new Set(typy.filter((typ) => DO_UKRYCIA.includes(typ)))];
}

export function ukrytePrzezWszystkich(ustawieniaKont) {
  return ustawieniaKont.length
    ? RODZAJE_OSTRZEZEN.filter((r) => ustawieniaKont.every((typy) => typy.includes(r.typ)))
    : [];
}
