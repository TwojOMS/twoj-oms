// Okres BIEZACY celu — czysta arytmetyka dni, zero bazy i zero I/O.
//
// ⚠️ ETYKIETY TU NIE MA CELOWO. Nazwe okresu po polsku sklada `nazwaOkresu({ od, do })`
// z domain/okresy-raportu.js, ktora juz jest przetestowana i ktorej uzywaja RAPORTY.
// Druga sciezka nazywajaca okresy rozjechalaby sie z raportami przy pierwszej zmianie
// formatu — a rozjazd nazw miedzy dwiema zakladkami wyglada jak blad w liczbach.

import { zakresMiesiaca } from './okresy-raportu.js';

const zDnia = (s) => new Date(`${s}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);

/**
 * Zakres dni okresu biezacego dla celu.
 *
 * @param {'tydzien'|'miesiac'|'jednorazowy'} rytm
 * @param {string} dzien dzien odniesienia 'RRRR-MM-DD' (WARSZAWSKI — wola go trasa)
 * @param {{odDnia?: string|null, doDnia?: string|null}} [granice] tylko dla 'jednorazowy'
 * @returns {{od: string|null, do: string|null}}
 */
export function okresCelu(rytm, dzien, { odDnia = null, doDnia = null } = {}) {
  if (rytm === 'tydzien') {
    const d = zDnia(dzien);
    // getUTCDay: niedziela = 0. `(dzien + 6) % 7` robi z poniedzialku zero, czyli poczatek
    // tygodnia — DOKLADNIE ta sama linia, co w `tygodnieOkresu` (okresy-raportu.js:243).
    // Gdyby te dwie konwencje sie rozjechaly, „ten tydzien" na CELACH i slupek tygodniowy
    // w RAPORTACH pokazywalyby rozne zakresy dla tego samego dnia — a to wyglada jak blad
    // w liczbach, nie jak roznica definicji.
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    const k = new Date(d);
    k.setUTCDate(k.getUTCDate() + 6);
    return { od: iso(d), do: iso(k) };
  }
  if (rytm === 'miesiac') {
    // Luty przestepny wychodzi tam sam — dzien 0 nastepnego miesiaca, bez recznego warunku.
    const { od, do: doDniaM } = zakresMiesiaca(dzien.slice(0, 7));
    return { od, do: doDniaM };
  }
  if (rytm === 'jednorazowy') {
    // NULL po obu stronach znaczy „od zawsze, bez terminu" — cel siedzi w pasie gornym,
    // dopoki jest czynny. Formularz nie wymusza zadnej z tych dat.
    return { od: odDnia ?? null, do: doDnia ?? null };
  }
  // ⚠️ FAIL-CLOSED. Pusty okres przeszedlby dalej jako „zero zdarzen w okresie", czyli cel
  // bez postepu — nieodroznialny od „nikt nic nie zrobil". Blad ma wyjsc przy zapisie.
  throw new Error(`okresCelu: nieznany rytm ${rytm}`);
}

/**
 * Rytmy dopuszczalne przy zapisie celu.
 *
 * ⚠️ JEDNA LISTA dla walidacji trasy i dla `<select>` w formularzu. Dwie kopie dalyby
 * formularz oferujacy rytm, ktory `okresCelu` odrzuca — a blad widac dopiero po kliknieciu
 * „Zaloz cel". Test pilnuje, ze kazda pozycja tej listy przechodzi przez `okresCelu`.
 */
export const RYTMY = ['tydzien', 'miesiac', 'jednorazowy'];
