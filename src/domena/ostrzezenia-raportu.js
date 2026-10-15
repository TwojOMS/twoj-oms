import { zl } from './kwoty.js';

// Pas ostrzezen ekranu raportow.
//
// ⚠️ LISTA JEST ZAMKNIETA I MA TAKA ZOSTAC. Ostrzezenie wyjace przy dobrych danych przestaje
// znaczyc cokolwiek — w repo `raporty` regula `podejrzanyBrakTagu` wypisywala szesc alarmow
// o POPRAWNIE otagowanym hurcie i przez to nikt nie czytal calego pasa.

const odmiana = (n, jeden, kilka, wiele) => {
  if (n === 1) return jeden;
  const r = n % 10;
  const d = n % 100;
  return (r >= 2 && r <= 4 && !(d >= 12 && d <= 14)) ? kilka : wiele;
};

export function ostrzezenia(wiersze, { od, do: doDnia, granice, kanalGddWHistorii }) {
  const wynik = [];

  // 1. Okres przecina granice historii — liczby z dwoch epok, warto o tym wiedziec.
  const przeciete = granice.filter((g) => g.do_dnia >= od && g.do_dnia < doDnia);
  if (przeciete.length) {
    wynik.push({
      kod: 'granica',
      tresc: `Okres przecina granicę historii: ${przeciete.map((g) => `${g.kanal} (do ${g.do_dnia})`).join(', ')}.`
        + ' Do tej daty liczby pochodzą z Apilo, po niej — z panelu.',
    });
  }

  // 2. Zamowienia bez ZADNEGO tagu — wylacznie w erze historycznej, bo wiersz z OMS-u
  //    tagow nie ma z definicji i alarm o nim bylby wyciem przy dobrych danych.
  //
  // ⚠️⚠️ TYLKO WIERSZE Z APILO (27.08.2026). Historia ma od tej daty DWA zrodla, a import
  //    ze sklepu wnosi ~8 500 zamowien, ktore tagu nie mialy NIGDY i miec nie mogly — Woo
  //    nie zna tagow Apilo. Bez tego warunku pas krzyczalby „8 500 zamowien bez tagu" przy
  //    kazdym raporcie siegajacym przed pazdziernik 2024 — czyli dokladnie to wycie przy
  //    dobrych danych, przed ktorym ostrzega naglowek tego pliku.
  const bezTagu = wiersze.filter(
    (w) => w.zrodlo === 'historia' && w.zrodloDanych === 'apilo' && !(w.tagi ?? []).length,
  );
  if (bezTagu.length) {
    wynik.push({
      kod: 'bez-tagu',
      tresc: `${bezTagu.length} ${odmiana(bezTagu.length, 'zamówienie', 'zamówienia', 'zamówień')}`
        + ' z historii nie ma żadnego tagu — tagi nadawano wstecz dopiero w lipcu 2026,'
        + ' więc podział na kanały może być w tym okresie niepełny.',
    });
  }

  // 3. Zamowienia bez potwierdzonej platnosci — 67 sztuk na 9 425,65 zl netto w I polroczu
  //    2026 i do dzis nie wiadomo, czy to porzucone koszyki. Raport ma dac material.
  const bezPlatnosci = wiersze.filter((w) => !w.oplacone);
  if (bezPlatnosci.length) {
    const suma = bezPlatnosci.reduce((s, w) => s + w.nettoGrosze, 0);
    wynik.push({
      kod: 'bez-platnosci',
      tresc: `${bezPlatnosci.length} ${odmiana(bezPlatnosci.length, 'zamówienie', 'zamówienia', 'zamówień')}`
        + ` bez potwierdzonej płatności, na ${zl(suma).replace('.', ',')} zł netto.`
        + ' Porzucone, ale nieanulowane zamówienie liczy się tutaj jako sprzedaż.',
    });
  }

  // 4. Kanal z tagu historii (`tagGdd`) znika po granicy — OMS nie ma dzis dla niego znacznika.
  //    PRZ-073: granice ma kazdy kanal algorytmiczny (demo zaklada ja wszystkim), wiec o samym
  //    kanale mowi wylacznie instancja, ktorej klasyfikacja ten tag ma.
  const granicaGdd = kanalGddWHistorii === true ? granice.find((g) => g.kanal === 'GDD') : undefined;
  if (granicaGdd && doDnia > granicaGdd.do_dnia) {
    wynik.push({
      kod: 'gdd',
      tresc: `Po granicy historii kanał ${granicaGdd.kanal} nie istnieje —`
        + ' panel nie ma dziś znacznika, który odróżniałby go od zamówień indywidualnych.'
        + ' Te zamówienia wchodzą po granicy do kanału Indywidualne.',
    });
  }

  return wynik;
}
