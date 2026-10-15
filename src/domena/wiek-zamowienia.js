// Zegar wieku zamówienia na liście (spec: docs/superpowers/specs/2026-08-23-wiek-zamowien-design.md).
//
// Jedna formuła spóźnienia dla wszystkich typów: po terminie ⇔ dniRoboczeMiedzy(start, teraz)
// > limit. Kolor pojawia się DOPIERO po przekroczeniu — faza ostrzegawcza odrzucona wprost
// (decyzja właściciela, 23.08.2026).
//
// ⚠️⚠️ SAMA FORMUŁA (typ → limit, start zegara, odcięcie 12:00) NIE MIESZKA JUŻ W TYM PLIKU
// — od 13.09.2026 stoi w `domain/termin-wysylki.js`, bo zakładka STATYSTYKI zadaje jej to
// samo pytanie o INNY moment („czy paczka, która wyszła, wyszła w terminie"). Druga kopia
// limitów i odcięcia rozjechałaby się przy pierwszej zmianie reguły, i to cicho: obie liczby
// wyglądałyby sensownie, a mówiłyby co innego. Uzasadnienia każdej z tych reguł — razem
// z tym, dlaczego godzinę wolno czytać WYŁĄCZNIE przez `fmtDataCzasKrotko` — siedzą przy
// nich, w tamtym pliku.
//
// ⚠️ TEN PLIK ZOSTAJE PRZY DWÓCH ROBOTACH, których tamten nie zna: GAŚNIĘCIU zegara
// (wysłane albo anulowane → `null`) i SKŁADANIU NAPISÓW dla listy. Gaśnięcie jest tutaj
// właśnie dlatego, że statystyki potrzebują dokładnie odwrotnie — wyłącznie zamówień
// wysłanych.
import { dniRoboczeMiedzy } from './etap-przesylki.js';
import { dzienWarszawa } from './format-daty.js';
import { anulowaneEfektywnie } from './status-reczny.js';
import { typZamowienia, startZegara, terminZamowienia } from './termin-wysylki.js';

// Ta sama zasada, co `expressPattern` w panelu indywidualnym (src/domain/settings-defaults.js,
// domyślnie „priorytetowa, ekspres”): ekspres poznaje się po NAZWIE pozycji, bo dodatek
// z formularza proformy wchodzi do zamówienia pozycją „Realizacja ekspresowa”.
const FRAGMENTY_EKSPRESU = ['ekspres', 'priorytetowa'];

export function czyEkspres(pozycje) {
  return (pozycje ?? []).some((p) => {
    const nazwa = String(p?.nazwa ?? '').toLowerCase();
    return FRAGMENTY_EKSPRESU.some((f) => nazwa.includes(f));
  });
}

const DZIEN_MS = 24 * 3600 * 1000;
const DNI_TYG = ['nd', 'pn', 'wt', 'śr', 'czw', 'pt', 'sob'];

function nastepnyRoboczy(dzienIso) {
  let t = Date.parse(`${dzienIso}T00:00:00Z`);
  do { t += DZIEN_MS; } while ([0, 6].includes(new Date(t).getUTCDay()));
  return new Date(t).toISOString().slice(0, 10);
}

const odmianaDniRob = (n) => (n === 1 ? '1 dzień rob.' : `${n} dni rob.`);
const odmianaDni = (n) => (n === 0 ? 'dziś' : n === 1 ? '1 dzień' : `${n} dni`);

function etykietaDnia(dzienIso, dzisIso) {
  const roznica = (Date.parse(`${dzienIso}T00:00:00Z`) - Date.parse(`${dzisIso}T00:00:00Z`)) / DZIEN_MS;
  // „dziś" obejmuje też weekend po piątkowym terminie — o kolorze i tak decyduje wyłącznie poTerminie.
  if (roznica <= 0) return 'dziś';
  if (roznica === 1) return 'jutro';
  const d = new Date(Date.parse(`${dzienIso}T00:00:00Z`));
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${DNI_TYG[d.getUTCDay()]} ${dd}.${mm}`;
}

/**
 * `null` = zegar nie dotyczy (wysłane, anulowane). Poza tym ZAWSZE oddaje gotowe napisy —
 * widok niczego nie skleja i nie tłumaczy (ta sama zasada, co ikony listy).
 */
export function wiekZamowienia(z, teraz = new Date()) {
  if (z?.wyslane_at || anulowaneEfektywnie(z)) return null;
  const terazIso = teraz instanceof Date ? teraz.toISOString() : String(teraz);
  const dzis = dzienWarszawa(terazIso);

  // Wiek liczony DNIAMI WARSZAWSKIMI, nie surową różnicą chwil — daty sklepu i nasze
  // znaczniki UTC muszą wpadać w ten sam dzień, w którym pokazuje je kolumna (format-daty).
  const dzienZlozenia = dzienWarszawa(z?.utworzone_at ?? '');
  const wiekDni = dzienZlozenia && dzis
    ? Math.max(0, Math.round((Date.parse(`${dzis}T00:00:00Z`) - Date.parse(`${dzienZlozenia}T00:00:00Z`)) / DZIEN_MS))
    : 0;
  const wiek = odmianaDni(wiekDni);

  // ⚠️ JEDNA FORMUŁA TERMINU NA PANEL — typ, start, limit i odcięcie 12:00 liczy
  // domain/termin-wysylki.js, ten sam moduł, z którego liczy zakładka STATYSTYKI.
  // Żadna z tych czterech reguł nie ma prawa stać w tym pliku drugi raz.
  const typ = typZamowienia(z);
  // `null` znaczy „zegar nie ma od czego ruszyć": nieopłacona przedpłata albo śmieciowa data.
  const termin = terminZamowienia(z);
  if (!termin) {
    // Rozróżnienie, którego `terminZamowienia` nie robi, bo nie musi: BRAK wpłaty dostaje
    // napis do człowieka, a ŚMIECIOWA data — pusty opis i zegar bez koloru.
    if (!startZegara(z)) return { wiek, opis: 'czeka na wpłatę', poTerminie: false, typ };
    return { wiek, opis: '', poTerminie: false, typ };
  }
  const { start, dzienStartu, limit, cutoffAllegro } = termin;
  // Potrzebne niżej, przy wyborze słowa „złożone" vs „opłacone".
  const odZlozenia = Boolean(z?.pobranie) || Boolean(z?.b2b);

  const zuzyte = dniRoboczeMiedzy(start, terazIso);
  if (zuzyte > limit) return { wiek, opis: `po terminie o ${odmianaDniRob(zuzyte - limit)}`, poTerminie: true, typ };

  const prefiks = odZlozenia && !z?.oplacone_at ? 'złożone' : 'opłacone';
  if (limit >= 2) {
    return { wiek, opis: `od ${prefiks === 'złożone' ? 'złożenia' : 'wpłaty'} ${zuzyte}/${limit} dni rob.`, poTerminie: false, typ };
  }
  const deadline = limit === 0 ? dzienStartu : nastepnyRoboczy(dzienStartu);
  let opis = `wysyłka: ${etykietaDnia(deadline, dzis)}`;
  // ⚠️ Dopisek 12:00 WYŁĄCZNIE przy starcie PRZED odcięciem (prośba właściciela 23.08). Tam niesie
  // powód, dla którego paczka ma wyjechać jeszcze DZIŚ — czyli jedyne miejsce, gdzie odcięcie
  // zmienia czyjeś działanie. Przy „jutro" mówiłby to, co termin już powiedział, a przy
  // sobotnim zamówieniu byłby wręcz zmyśleniem (odcięcie nie brało udziału w decyzji).
  // `cutoffAllegro` niesie już oba warunki: kanał Allegro I dzień roboczy przed 12:00.
  if (cutoffAllegro) opis += ` · ${prefiks} przed 12:00`;
  return { wiek, opis, poTerminie: false, typ };
}
