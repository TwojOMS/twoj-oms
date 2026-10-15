// src/oms/domain/okno-formulki.js
// ⚠️⚠️ TO JEST DRUGIE MIEJSCE W OMS-ie, KTORE ZNA STREFE WARSZAWY (pierwsze:
// domain/pora-pobrania.js). Ta sama zasada, co tam: strefa sluzy WYLACZNIE do ODCZYTU
// godziny i dnia — zadnego dodawania godzin, zadnego `setHours`, zadnej arytmetyki dat.
// Kontener chodzi w UTC, a wlasciciel ustawia okno w czasie, ktory widzi na zegarze.
//
// ⚠️ OKNO PRZECHODZI PRZEZ POLNOC i to jest przypadek TYPOWY, nie brzegowy: „18-8" znaczy
// „po godzinach". Naiwne `godzina >= od && godzina < do` daje wtedy ZAWSZE false, czyli
// autoresponder, ktory nigdy nie odpowiada — i wyglada to na cisze, nie na usterke.
//
// ⚠️ DZIEN LICZY SIE DLA CHWILI, NIE DLA POCZATKU OKNA. Wiadomosc o 00:30 w nocy z piatku
// na sobote przychodzi w SOBOTE. Gdyby liczyc dzien rozpoczecia okna, ptaszek „sobota"
// nie robilby nic, a odznaczenie soboty nadal wpuszczaloby noc z piatku.

const FORMAT = new Intl.DateTimeFormat('pl-PL', {
  timeZone: 'Europe/Warsaw', hour: 'numeric', hourCycle: 'h23', weekday: 'short',
});

// `hourCycle: 'h23'` jest istotny — bez niego polnoc wychodzi jako „24", a nie „0".
const DNI_SKROTY = { niedz: 0, pon: 1, wt: 2, sr: 3, czw: 4, pt: 5, sob: 6 };

function godzinaIDzien(chwila) {
  const czesci = FORMAT.formatToParts(chwila);
  const godzina = Number(czesci.find((c) => c.type === 'hour').value);
  // ⚠️ Skrot dnia bierzemy z `formatToParts`, a NIE z `chwila.getDay()`: `getDay()` oddaje
  // dzien w strefie PROCESU (UTC w kontenerze), wiec noc z piatku na sobote wychodzilaby
  // jako piatek. Normalizacja usuwa kropke i ogonki („śr.” -> „sr”).
  const skrot = czesci.find((c) => c.type === 'weekday').value
    .toLowerCase().replace('.', '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
  return { godzina, dzien: DNI_SKROTY[skrot] };
}

/**
 * Czy `chwila` (Date) wpada w okno. Godzina poczatku WLICZONA, godzina konca WYLACZONA.
 * `od === do` znaczy okno calodobowe.
 */
export function czyWOknie(chwila, { odGodziny, doGodziny, dni }) {
  const { godzina, dzien } = godzinaIDzien(chwila);
  if (!Array.isArray(dni) || !dni.includes(dzien)) return false;
  if (odGodziny === doGodziny) return true;
  if (odGodziny < doGodziny) return godzina >= odGodziny && godzina < doGodziny;
  // Przez polnoc: okno to suma dwoch kawalkow doby.
  return godzina >= odGodziny || godzina < doGodziny;
}
