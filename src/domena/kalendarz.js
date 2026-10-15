// Kalendarz — jedna arytmetyka dat dla całego OMS-u.
//
// Wyjęte z `domain/termin-platnosci.js`, gdzie mieszkały prywatnie, bo tych samych obliczeń
// potrzebuje lista faktur (zakres miesiąca, dni do terminu). DRUGA KOPIA byłaby tu gorsza niż
// zwykłe powtórzenie: rozjechałaby się przy pierwszej poprawce, a rozjazd znaczy termin
// płatności przesunięty o dzień na dokumencie księgowym.
//
// Treść funkcji przeniesiona bez zmian — to przeprowadzka, nie ulepszanie.

const WZORZEC_DATY = /^(\d{4})-(\d{2})-(\d{2})$/;

// Arytmetyka na NUMERZE DNIA (kalendarz gregoriański, Fliegel–Van Flandern), na liczbach
// całkowitych — nigdy przez `new Date()` i nigdy przez dodawanie milisekund.
//
// Powód jest praktyczny, nie estetyczny: `+ n*86400000` gubi albo dokłada dzień przy zmianie
// czasu (ostatnia niedziela października ma w Warszawie 25 godzin), a `new Date('2026-10-25')`
// czyta napis jako UTC i po przeliczeniu na strefę potrafi cofnąć się o dobę. Termin płatności
// przesunięty o jeden dzień to termin, którego klient nie uzgodnił — na dokumencie księgowym.
export function naNumerDnia(rok, miesiac, dzien) {
  const a = Math.floor((14 - miesiac) / 12);
  const r = rok + 4800 - a;
  const m = miesiac + 12 * a - 3;
  return dzien + Math.floor((153 * m + 2) / 5) + 365 * r
    + Math.floor(r / 4) - Math.floor(r / 100) + Math.floor(r / 400) - 32045;
}

export function zNumeruDnia(numer) {
  const a = numer + 32044;
  const b = Math.floor((4 * a + 3) / 146097);
  const c = a - Math.floor((146097 * b) / 4);
  const d = Math.floor((4 * c + 3) / 1461);
  const e = c - Math.floor((1461 * d) / 4);
  const m = Math.floor((5 * e + 2) / 153);
  return {
    rok: 100 * b + d - 4800 + Math.floor(m / 10),
    miesiac: m + 3 - 12 * Math.floor(m / 10),
    dzien: e - Math.floor((153 * m + 2) / 5) + 1,
  };
}

const dwucyfrowo = (n) => String(n).padStart(2, '0');
export const sklejDate = ({ rok, miesiac, dzien }) => `${rok}-${dwucyfrowo(miesiac)}-${dwucyfrowo(dzien)}`;

// Data z formularza sprawdzana PRZEZ ODWZOROWANIE W OBIE STRONY, nie samym regexem: wzorzec
// bez oporu przepuszcza „2026-02-30" i „2026-13-01", a inFakt dostałby wtedy datę, której
// nie ma w kalendarzu.
export function numerDniaZNapisu(napis) {
  const m = WZORZEC_DATY.exec(napis);
  if (!m) return null;
  const [rok, miesiac, dzien] = m.slice(1).map(Number);
  if (miesiac < 1 || miesiac > 12 || dzien < 1 || dzien > 31) return null;
  const numer = naNumerDnia(rok, miesiac, dzien);
  return sklejDate(zNumeruDnia(numer)) === napis ? numer : null;
}
