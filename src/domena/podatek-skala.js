// Podatek dochodowy — SKALA 12/32%, liczony NARASTAJACO OD STYCZNIA.
//
// ⚠️ NARASTANIE JEST WARUNKIEM, NIE OZDOBA: bez niego nie da sie wykryc wejscia w drugi prog,
// a to jedyna zmiana, ktora potrafi z dnia na dzien przestawic „ile zostaje" o kilkanascie
// procent.
//
// ⚠️ SKLADKA ZDROWOTNA NIE JEST TU ARGUMENTEM I NIE MA BYC — na skali sie jej NIE ODLICZA.
// Dopisanie jej do podstawy bylo najczestszym bledem w recznych wyliczeniach.
//
// ⚠️ WSZYSTKO, CO STAD WYCHODZI, TO SZACUNEK: bez ulg, wspolnego rozliczenia i strat z lat
// ubieglych. Wiazace sa liczby biura rachunkowego. Ekran ma to pisac wprost.

export const PROG_GROSZE = 120_000_00;
const STAWKA_I = 0.12;
const STAWKA_II = 0.32;
const KWOTA_ZMNIEJSZAJACA_GROSZE = 3_600_00;

export function podatekNarastajaco({ dochodGrosze, spoleczneGrosze }) {
  const surowa = Math.max(0, dochodGrosze - spoleczneGrosze);
  // Podstawa zaokraglona do pelnych zlotych — tak jak w zeznaniu.
  const podstawaGrosze = Math.round(surowa / 100) * 100;

  const wDrugimProgu = podstawaGrosze > PROG_GROSZE;
  const wPierwszym = Math.min(podstawaGrosze, PROG_GROSZE);
  const nadwyzka = Math.max(0, podstawaGrosze - PROG_GROSZE);

  const podatekGrosze = Math.max(0, Math.round(
    wPierwszym * STAWKA_I - KWOTA_ZMNIEJSZAJACA_GROSZE + nadwyzka * STAWKA_II,
  ));

  return {
    podstawaGrosze,
    podatekGrosze,
    wDrugimProgu,
    doProguGrosze: Math.max(0, PROG_GROSZE - podstawaGrosze),
  };
}

/**
 * ⚠️ NAJMNIEJ PELNYCH MIESIECY, Z KTORYCH WOLNO WYCIAGAC TEMPO. Styczen i luty potrafia sie
 * roznic o polowe (2026-01: 13 836 zl, 2026-07: 33 786 zl brutto) — prognoza z jednego
 * miesiaca powiedzialaby cokolwiek i wygladalaby dokladnie tak samo wiarygodnie.
 */
export const MIN_MIESIECY_PROGNOZY = 3;

/** Ostatni dzien miesiaca — dzien 0 nastepnego. Luty przestepny wychodzi sam. */
const koniecMiesiaca = (dzien) => new Date(
  Date.UTC(Number(dzien.slice(0, 4)), Number(dzien.slice(5, 7)), 0),
).toISOString().slice(0, 10);

/**
 * Czy przy dzisiejszym tempie prog 32% padnie do konca roku — i ile to kosztuje.
 *
 * ⚠️⚠️ TO JEST TEMPO LINIOWE, NIE SEZONOWOSC, i ekran ma to pisac wprost. Sezonowego
 * rozkladu DOCHODU panel nie zna: sprzedaz siega 2025, ale koszty zaczynaja sie od podlogi
 * KSeF (2026-01), wiec za 2025 nie ma z czego policzyc dochodu miesiac po miesiacu. Prognoza
 * wazona zeszlym rokiem bedzie mozliwa dopiero w 2027.
 *
 * ⚠️ ZWRACA `null` (czyli „nie prognozujemy"), a nie liczbe „na wszelki wypadek", gdy:
 *   • zakres konczy sie W POLOWIE MIESIACA — podstawa narastajaco obejmuje wtedy kawalek
 *     miesiaca, a dzielnik liczylby go jako pelny, wiec tempo wychodzi ZAWYZONE;
 *   • pelnych miesiecy jest mniej niz `MIN_MIESIECY_PROGNOZY`;
 *   • trwa grudzien — rok jest zamkniety i prognoza nie ma czego dodac do faktu;
 *   • prog JUZ zostal przekroczony — ekran mowi to wprost, a prognozowanie zdarzenia,
 *     ktore sie wydarzylo, brzmialoby jak zaprzeczenie liczby stojacej obok.
 *
 * `przekroczy: false` NIE jest tym samym, co `null`: to jest zdanie o faktach („przy tym
 * tempie progu nie bedzie") i ekran ma je POWIEDZIEC, zamiast milczec.
 */
export function prognozaProgu({ podstawaGrosze, doDnia }) {
  if (doDnia !== koniecMiesiaca(doDnia)) return null;
  const miesiecy = Number(doDnia.slice(5, 7));
  if (miesiecy < MIN_MIESIECY_PROGNOZY || miesiecy >= 12) return null;
  if (podstawaGrosze > PROG_GROSZE) return null;

  const tempoGrosze = Math.round(podstawaGrosze / miesiecy);
  const podstawaRokuGrosze = tempoGrosze * 12;
  const nadwyzkaGrosze = Math.max(0, podstawaRokuGrosze - PROG_GROSZE);

  // ⚠️ Nadwyzka jest opodatkowana 32% ZAMIAST 12%, wiec doplata to roznica stawek, a nie
  // pelne 32% — policzone pelna stawka wyszloby prawie trzy razy za duzo.
  return {
    miesiecy,
    tempoGrosze,
    podstawaRokuGrosze,
    przekroczy: nadwyzkaGrosze > 0,
    // Miesiac, w ktorym narastajaca podstawa mija prog. Bez nadwyzki nie ma takiego miesiaca
    // i `null` mowi to wprost — zero wygladaloby jak styczen.
    miesiacPrzekroczenia: nadwyzkaGrosze > 0 ? Math.ceil(PROG_GROSZE / tempoGrosze) : null,
    nadwyzkaGrosze,
    dodatkowyPodatekGrosze: Math.round(nadwyzkaGrosze * (STAWKA_II - STAWKA_I)),
  };
}
