// PODGLĄD KWOTY na ekranie „Nowe zamówienie" (07.08.2026, prośba właściciela: „pozycje
// powinny się sumować i pokazywać kwotę zamówienia").
//
// ⚠️⚠️ TO JEST DRUGA IMPLEMENTACJA REGUŁY, KTÓRA MA PIERWOWZÓR W `domain/suma-pozycji.js`,
// i do 07.08.2026 widok wprost odmawiał jej istnienia („liczenie w przeglądarce byłoby DRUGĄ
// implementacją reguły — dwa miejsca, które prędzej czy później się rozjadą"). Właściciel
// wybrał liczenie na żywo świadomie, więc obiekcja nie znika — zostaje SPŁACONA:
//
//   `tests/oms/suma-podglad.test.js` importuje TEN PLIK i puszcza go razem z prawdziwym
//   parserem serwera (`parsujPozycjeFormularza` + `sumaPozycjiZWysylkaGrosze`) po wspólnej
//   tablicy przypadków — przecinki dziesiętne, netto zamiast brutta, zaokrąglenia, puste
//   i niepełne wiersze. Rozjazd którejkolwiek strony wywala test, a nie fakturę.
//
// Dlatego reguły poniżej są przepisane DOSŁOWNIE, razem z kolejnością kroków. Każde
// „uproszczenie" tutaj (liczenie na złotówkach, `parseFloat`, zaokrąglenie na końcu) rozjedzie
// się z serwerem o grosz — a to jest kwota, którą operator dyktuje klientowi przez telefon
// i którą przy pobraniu inkasuje kurier.
//
// ⚠️ CZEGO TEN PODGLĄD NIE OBEJMUJE: opłaty za obsługę doklejanej klientom rozliczanym
// zbiorczo (`services/oplata.js` — 4 zł albo 19 zł zależnie od etykiety i progu darmowej
// dostawy). O tym, czy się należy, decyduje NIP z listy w konfiguracji serwera, której
// przeglądarka nie zna i znać nie ma — kopiowanie tej listy do strony byłoby powielaniem
// POLITYKI CENOWEJ, nie arytmetyki. Właściciel wie o tym i **świadomie nie chciał ostrzeżenia
// na ekranie** (decyzja 07.08.2026). Prawdziwą kwotę pokazuje karta zaraz po zapisie.

// Stawka VAT NIE jest tu wpisana na sztywno — dojeżdża atrybutem `data-vat` formularza,
// dokładnie jak w `_skrypt-cena.ejs`. Druga, wpisana wprost kopia stawki rozjechałaby się
// cicho z fakturą przy pierwszej zmianie.
const KOLUMNY = ['nazwa', 'sku', 'ilosc', 'cena_netto', 'cena_brutto'];

/** `domain/suma-pozycji.js: grosze` — bez rzucania: podgląd oddaje `null`, nie wyjątek. */
function grosze(kwota) {
  const t = String(kwota ?? '').trim().replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/** `domain/vat.js: bruttoZNetto` — przez grosze, nigdy na złotówkach. */
function bruttoZNetto(netto, procentVat) {
  const gr = grosze(netto);
  if (gr === null) return null;
  return Math.round(gr * (1 + procentVat / 100));
}

/**
 * `domain/pozycje-reczne.js: parsujIlosc` — całkowita, większa od zera.
 * Ułamek jest ODMOWĄ, nie zaokrągleniem: cała warstwa liczy na całkowitych groszach.
 */
function ilosc(surowa) {
  const t = String(surowa ?? '').trim().replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

/** Wiersz CAŁKOWICIE pusty jest pomijany — normalny stan czterech z pięciu wierszy. */
export function pustyWiersz(w) {
  return KOLUMNY.every((k) => String(w?.[k] ?? '').trim() === '');
}

/**
 * Wartość jednej linii w groszach albo `null`, gdy wiersza nie da się policzyć.
 *
 * ⚠️ BRUTTO WYGRYWA, GDY PODANE — netto jest tylko wygodniejszym sposobem jego podania
 * (`parsujNowaPozycje`). Serwer przelicza z netta WYŁĄCZNIE przy pustym polu brutto.
 */
export function liniaGrosze(w, procentVat) {
  const szt = ilosc(w?.ilosc);
  if (szt === null) return null;
  const wprost = String(w?.cena_brutto ?? '').trim();
  const gr = wprost !== '' ? grosze(wprost) : bruttoZNetto(w?.cena_netto, procentVat);
  // Cena zero i ujemna to odmowa po stronie serwera (`parsujCeneBrutto`), więc i tutaj.
  if (gr === null || gr <= 0) return null;
  return gr * szt;
}

/**
 * Kwota całego formularza w groszach.
 *
 * `null` znaczy „nie umiem tego policzyć" i bierze się z wiersza ZACZĘTEGO, ale niepełnego —
 * czyli dokładnie z tego, co serwer odrzuci komunikatem „Wiersz 3: podaj cenę". Podgląd
 * pokazuje wtedy myślnik zamiast liczby: kwota mniejsza o pominięty wiersz byłaby gorsza
 * niż jej brak, bo wygląda na prawdziwą.
 */
export function kwotaFormularzaGrosze(wiersze, kosztDostawy, procentVat) {
  let suma = 0;
  for (const w of wiersze ?? []) {
    if (pustyWiersz(w)) continue;
    const linia = liniaGrosze(w, procentVat);
    if (linia === null) return null;
    suma += linia;
  }
  // `parsujKosztDostawy`: puste pole znaczy ZERO, wartość nieliczbowa albo ujemna — odmowę.
  const surowy = String(kosztDostawy ?? '').trim();
  if (surowy !== '') {
    const gr = grosze(surowy);
    if (gr === null || gr < 0) return null;
    suma += gr;
  }
  return suma;
}

/** Grosze na złotówki — `domain/suma-pozycji.js: zl`. */
export const zl = (gr) => (gr / 100).toFixed(2);

// ---------------------------------------------------------------------------------
// PODPIĘCIE DO STRONY. Warunek na `document` jest po to, żeby ten sam plik dało się
// zaimportować w teście pod Node — bez niego import wywaliłby się na braku DOM-u, a wtedy
// test pilnowałby kopii reguły zamiast tej, którą naprawdę wykonuje przeglądarka.
// ---------------------------------------------------------------------------------
export function podepnij(dokument) {
  const tabela = dokument.querySelector('[data-podglad-kwoty]');
  if (!tabela) return null;
  const formularz = tabela.closest('form');
  const procent = formularz ? Number(formularz.dataset.vat) : NaN;
  // Brak albo zepsuty atrybut wyłącza WYŁĄCZNIE podgląd — formularz działa dalej, bo kwotę
  // i tak liczy serwer przy zapisie (ta sama zasada, co w `_skrypt-cena.ejs`).
  if (!Number.isFinite(procent) || procent <= 0) return null;

  const wiersze = Array.from(tabela.querySelectorAll('tbody tr'));
  const komorkaRazem = dokument.querySelector('[data-razem]');
  const poleDostawy = formularz ? formularz.querySelector('[name="koszt_dostawy_brutto"]') : null;

  const odczytaj = (tr) => Object.fromEntries(
    KOLUMNY.map((k) => [k, (tr.querySelector(`[name="poz_${k}"]`) || {}).value ?? '']),
  );

  function przelicz() {
    const dane = wiersze.map(odczytaj);
    wiersze.forEach((tr, i) => {
      const komorka = tr.querySelector('[data-suma-linii]');
      if (!komorka) return;
      const linia = pustyWiersz(dane[i]) ? null : liniaGrosze(dane[i], procent);
      komorka.textContent = linia === null ? '' : `${zl(linia)} zł`;
    });
    if (komorkaRazem) {
      const suma = kwotaFormularzaGrosze(dane, poleDostawy ? poleDostawy.value : '', procent);
      komorkaRazem.textContent = suma === null ? '—' : `${zl(suma)} zł`;
    }
  }

  // `input` na całym formularzu, nie na każdym polu z osobna: pola przeliczane przez
  // `_skrypt-cena.ejs` (netto → brutto) zmieniają się PROGRAMOWO, a takie przypisanie
  // zdarzenia `input` NIE wywołuje. Nasłuch na formularzu łapie za to zdarzenie oryginalne,
  // które tamten skrypt obsłużył — a że jego nasłuch został podpięty wcześniej, brutto jest
  // już policzone, zanim doliczymy sumę.
  if (formularz) formularz.addEventListener('input', przelicz);
  przelicz();
  return przelicz;
}

if (typeof document !== 'undefined') podepnij(document);
