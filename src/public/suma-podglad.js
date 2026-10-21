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

/**
 * Wiersz pusty jest pomijany. ⚠️ Ilość się nie liczy (PRZ-106): nowy wiersz ma ilość 1 od razu,
 * a nietknięty wiersz ma zostać pusty — ta sama reguła co `pusteWiersz` w domena/nowe-zamowienie.js.
 */
export function pustyWiersz(w) {
  return KOLUMNY.filter((k) => k !== 'ilosc').every((k) => String(w?.[k] ?? '').trim() === '');
}

/**
 * Wartość jednej linii w groszach albo `null`, gdy wiersza nie da się policzyć.
 *
 * ⚠️ BRUTTO WYGRYWA, GDY PODANE — netto jest tylko wygodniejszym sposobem jego podania
 * (`parsujNowaPozycje`). Serwer przelicza z netta WYŁĄCZNIE przy pustym polu brutto.
 */
export function liniaGrosze(w, procentVat, wdt = false) {
  const szt = ilosc(w?.ilosc);
  if (szt === null) return null;
  const wprost = String(w?.cena_brutto ?? '').trim();
  const gr = wprost !== '' ? grosze(wprost) : bruttoZNetto(w?.cena_netto, stawkaWiersza(w, procentVat, wdt));
  // Cena zero i ujemna to odmowa po stronie serwera (`parsujCeneBrutto`), więc i tutaj.
  if (gr === null || gr <= 0) return null;
  return gr * szt;
}

// ---------------------------------------------------------------------------------
// PRZ-105 — stawka WIERSZA, nabywca z UE i podsumowanie netto / VAT / brutto. Dosłowne kopie reguł serwera,
// przypięte testem wspólnej tablicy (tests/domena/suma-podglad.test.js):
//   - `domena/pozycje-reczne.js: parsujNowaPozycje` — pusta stawka = domyślna, przy WDT netto stawką 0;
//   - `domena/klient-zbiorczy.js: normalizujNip` + `domena/wdt.js: czyNipUe`;
//   - `domena/podsumowanie-wierszami.js` — netto linii = round(brutto × 100 / (100 + stawka)), suma linii.
// ---------------------------------------------------------------------------------

// `domena/klient-zbiorczy.js: KODY_KRAJOW_UE` — test porównuje odpowiedź z serwerem dla każdego prefiksu AA–ZZ.
const KODY_KRAJOW_UE = new Set([
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'EL', 'ES', 'FI', 'FR', 'HR', 'HU',
  'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'RO', 'SE', 'SI', 'SK', 'XI',
]);

/** `domena/wdt.js: czyNipUe` (przez `normalizujNip`) — numer z prefiksem państwa UE innego niż PL. */
export function czyNipUe(nip) {
  // `domena/dane-faktury.js: bezEtykietyNip` — „NIP: DE…” na dokumencie traci etykietę, więc tu też.
  const bezEtykiety = String(nip ?? '').trim().replace(/^NIP(?![A-Z0-9])\s*[:.\-]?\s*/i, '').trim();
  const surowy = bezEtykiety.replace(/[\s.\-/]/g, '').toUpperCase();
  const m = surowy.match(/^([A-Z]{2})([0-9A-Z]{2,14})$/);
  return Boolean(m && m[1] !== 'PL' && KODY_KRAJOW_UE.has(m[1]));
}

/** Stawka liczbowa wiersza: WDT → 0, wpisana w wierszu → ona, pusta → domyślna formularza. */
function stawkaWiersza(w, procentDomyslny, wdt) {
  if (wdt) return 0;
  const s = String(w?.vat ?? '').trim();
  return s !== '' && Number.isFinite(Number(s)) ? Number(s) : procentDomyslny;
}

/**
 * Podsumowanie netto / VAT / brutto formularza — regułą faktury, z dostawą jako osobną linią (stawka domyślna,
 * przy WDT 0). `null` tam, gdzie kwota też jest `null` (serwer by odmówił).
 */
export function podsumowanieFormularza(wiersze, kosztDostawy, procentVat, nip = '') {
  const wdt = czyNipUe(nip);
  const linie = [];
  for (const w of wiersze ?? []) {
    if (pustyWiersz(w)) continue;
    const linia = liniaGrosze(w, procentVat, wdt);
    if (linia === null) return null;
    linie.push({ bruttoGr: linia, stawka: stawkaWiersza(w, procentVat, wdt) });
  }
  const dostawa = dostawaGrosze(kosztDostawy);
  if (dostawa === null) return null;
  if (dostawa > 0) linie.push({ bruttoGr: dostawa, stawka: wdt ? 0 : procentVat });
  let nettoGr = 0;
  let bruttoGr = 0;
  for (const l of linie) {
    nettoGr += Math.round((l.bruttoGr * 100) / (100 + l.stawka));
    bruttoGr += l.bruttoGr;
  }
  return { nettoGr, vatGr: bruttoGr - nettoGr, bruttoGr, wdt, zeroKrajowe: !wdt && linie.some((l) => l.stawka === 0) };
}

/** `parsujKosztDostawy`: puste pole znaczy ZERO, wartość nieliczbowa albo ujemna — odmowę (`null`). */
function dostawaGrosze(kosztDostawy) {
  const surowy = String(kosztDostawy ?? '').trim();
  if (surowy === '') return 0;
  const gr = grosze(surowy);
  return gr === null || gr < 0 ? null : gr;
}

/**
 * Kwota całego formularza w groszach.
 *
 * `null` znaczy „nie umiem tego policzyć" i bierze się z wiersza ZACZĘTEGO, ale niepełnego —
 * czyli dokładnie z tego, co serwer odrzuci komunikatem „Wiersz 3: podaj cenę". Podgląd
 * pokazuje wtedy myślnik zamiast liczby: kwota mniejsza o pominięty wiersz byłaby gorsza
 * niż jej brak, bo wygląda na prawdziwą.
 */
export function kwotaFormularzaGrosze(wiersze, kosztDostawy, procentVat, nip = '') {
  const wdt = czyNipUe(nip);
  let suma = 0;
  for (const w of wiersze ?? []) {
    if (pustyWiersz(w)) continue;
    const linia = liniaGrosze(w, procentVat, wdt);
    if (linia === null) return null;
    suma += linia;
  }
  const dostawa = dostawaGrosze(kosztDostawy);
  return dostawa === null ? null : suma + dostawa;
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
  const surowyProcent = formularz ? formularz.dataset.vat : undefined;
  const procent = surowyProcent === undefined || String(surowyProcent).trim() === '' ? NaN : Number(surowyProcent);
  // Brak albo zepsuty atrybut wyłącza WYŁĄCZNIE podgląd — formularz działa dalej, bo kwotę
  // i tak liczy serwer przy zapisie (ta sama zasada, co w public/cena-netto.js). PRZ-105: 0 to stawka.
  if (!Number.isFinite(procent) || procent < 0) return null;

  // ⚠️ WIERSZE CZYTANE PRZY KAZDYM PRZELICZENIU, nie raz przy wczytaniu (PRZ-103): operator
  // dokłada i kasuje wiersze bez przeładowania (public/pozycje-wiersze.js). Lista zapamiętana
  // na starcie liczyłaby w „Razem” wiersz już skasowany, a dołożonego nie liczyłaby wcale.
  const komorkaRazem = dokument.querySelector('[data-razem]');
  const poleDostawy = formularz ? formularz.querySelector('[name="koszt_dostawy_brutto"]') : null;

  const poleNip = formularz ? formularz.querySelector('[name="f_nip"]') : null;
  const wez = (sel) => dokument.querySelector(sel);
  const ustaw = (sel, tekst) => { const el = wez(sel); if (el) el.textContent = tekst; };
  const pokaz = (sel, widoczny) => { const el = wez(sel); if (el) el.hidden = !widoczny; };

  // PRZ-105: stawka z listy wiersza (`poz_vat`) czytana obok kolumn — do pustości wiersza się nie liczy.
  const odczytaj = (tr) => ({
    ...Object.fromEntries(KOLUMNY.map((k) => [k, (tr.querySelector(`[name="poz_${k}"]`) || {}).value ?? ''])),
    vat: (tr.querySelector('[name="poz_vat"]') || {}).value ?? '',
  });

  function przelicz() {
    const wiersze = Array.from(tabela.querySelectorAll('tbody tr'));
    const dane = wiersze.map(odczytaj);
    const nip = poleNip ? poleNip.value : '';
    const wdt = czyNipUe(nip);
    // public/cena-netto.js czyta data-wdt przy następnym wpisaniu ceny — ten sam nabywca, ta sama stawka.
    // Zmiana nabywcy (krajowy ↔ UE) przelicza NETTO wierszy z brutto (brutto jest przechowywane i zostaje):
    // bez tego wiersz pokazywałby netto po 23%, a dokument poszedłby z 0%.
    if (formularz && formularz.dataset.wdt !== (wdt ? '1' : '0')) {
      formularz.dataset.wdt = wdt ? '1' : '0';
      wiersze.forEach((tr, i) => {
        const pn = tr.querySelector('[name="poz_cena_netto"]');
        const b = grosze(dane[i].cena_brutto);
        if (!pn || b === null) return;
        const s = stawkaWiersza(dane[i], procent, wdt);
        pn.value = zl(Math.round(b / (1 + s / 100)));
        dane[i].cena_netto = pn.value;
      });
    }
    wiersze.forEach((tr, i) => {
      const komorka = tr.querySelector('[data-suma-linii]');
      if (!komorka) return;
      const linia = pustyWiersz(dane[i]) ? null : liniaGrosze(dane[i], procent, wdt);
      komorka.textContent = linia === null ? '' : `${zl(linia)} zł`;
    });
    const koszt = poleDostawy ? poleDostawy.value : '';
    if (komorkaRazem) {
      const suma = kwotaFormularzaGrosze(dane, koszt, procent, nip);
      komorkaRazem.textContent = suma === null ? '—' : `${zl(suma)} zł`;
    }
    // Wiersz dostawy (właściciel 21.10: „Dodaj wiersz z dostawą”) — ta sama linia, co „Dostawa” na fakturze.
    const dostawa = dostawaGrosze(koszt);
    const stawkaDostawy = wdt ? 0 : procent;
    const nettoDostawy = dostawa === null ? null : Math.round((dostawa * 100) / (100 + stawkaDostawy));
    ustaw('[data-dostawa-brutto]', dostawa === null ? '—' : `${zl(dostawa)} zł`);
    ustaw('[data-dostawa-suma]', dostawa === null ? '—' : `${zl(dostawa)} zł`);
    ustaw('[data-dostawa-netto]', nettoDostawy === null ? '—' : `${zl(nettoDostawy)} zł`);
    ustaw('[data-dostawa-stawka]', wdt ? '0% — WDT' : `${procent}%`);
    // Podsumowanie netto / VAT / brutto (właściciel 21.10: „Brak sumy netto”).
    const p = podsumowanieFormularza(dane, koszt, procent, nip);
    ustaw('[data-pv-netto]', p ? zl(p.nettoGr) : '—');
    ustaw('[data-pv-vat]', p ? zl(p.vatGr) : '—');
    ustaw('[data-pv-brutto]', p ? zl(p.bruttoGr) : '—');
    pokaz('[data-pv-wdt]', wdt);
    pokaz('[data-pv-zero]', Boolean(p && p.zeroKrajowe));
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
