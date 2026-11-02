// PRZ-102.12 — reguły automatu wysyłki faktur do KSeF o ustalonej godzinie (zlecenie właściciela 20.10.2026).
//
// ⚠️ Automat NIE MA własnej reguły „co wysłać”. Bierze dokumenty, które na ekranie Faktur dostaje „zaznacz
// wszystkie” (`doZaznaczeniaWszystkich`, domena/wysylka-ksef.js), i wysyła je tą samą usługą co przycisk
// (`wysylkaKsef.wyslij` — bariera `coWolnoWyslac`, rezerwacja, ślad w logu). Tu jest wyłącznie: KIEDY.
//
// ⚠️ CZAS WARSZAWY TYLKO DO ODCZYTU dnia i godziny (ta sama technika co `fmtDataCzasKrotko`), żadnej arytmetyki
// na godzinach. Porównanie „HH:MM” na czasie lokalnym sprawia, że zmiana czasu nie przesuwa wysyłki, a „jedna
// próba na dzień” rozstrzyga DZIEŃ: podwójna 02:30 w październiku daje jeden przebieg, brakująca w marcu —
// przebieg o 03:00.
import { fmtDataCzasKrotko } from './format-daty.js';

export const GODZINA_DOMYSLNA = '20:00';
/** Nazwa operatora w logu zamówienia i w wyniku — człowiek ma odróżnić automat od kliknięcia. */
export const KTO_AUTOMAT = 'automat KSeF';
/** Pole daty listy faktur — to samo, co domyślne na ekranie Faktur. */
export const POLE_DATY_AUTOMATU = 'invoice_date';

const WZOR_GODZINY = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Najpóźniejsza godzina w formularzu (poprawka po recenzji PRZ-102.12). Zegar tyka co minutę, a pierwsze tyknięcie
 * przychodzi minutę po starcie panelu — przy 23:59 jedyne tyknięcie „po godzinie” mogło wypaść już po północy
 * i dzień przepadał (faktury czekały do jutra). Zamiast nadrabiania „wczoraj po północy” (druga ścieżka z innym
 * dniem i innym oknem miesięcy) — granica 23:45: zostaje 15 tyknięć do północy, a reguła „jedna próba na dzień”
 * zostaje jedna. Uszkodzona wartość z bazy ponad granicą nadal działa (czytnik jej nie odrzuca), ale z ekranu
 * nie da się jej zapisać.
 */
export const NAJPOZNIEJSZA_GODZINA = '23:45';

/** Dzień `RRRR-MM-DD` i godzina `HH:MM` w Warszawie dla chwili `teraz` (Date). */
export function chwilaWarszawy(teraz) {
  const tekst = fmtDataCzasKrotko(teraz.toISOString());
  return { dzien: tekst.slice(0, 10), godzina: tekst.slice(11, 16) };
}

/**
 * Czy to tyknięcie ma wysyłać: włączony, godzina Warszawy ≥ ustawiona i dziś jeszcze nie było przebiegu.
 * „Po godzinie” zamiast „o godzinie”, bo panel mógł stać o 20:00 — po starcie nadrabia jedną próbę.
 */
export function czyPoraPrzebiegu({ wlaczony, godzina, ostatniPrzebieg }, chwila) {
  if (!wlaczony || !WZOR_GODZINY.test(String(godzina ?? ''))) return false;
  if (ostatniPrzebieg === chwila.dzien) return false;
  return chwila.godzina >= godzina;
}

/**
 * Miesiące listy faktur: poprzedni i bieżący (`RRRR-MM`). Faktura z 31. wysyłana dopiero 1. leży już w
 * „poprzednim” — to samo okno co lustro luk czuwacza ostrzeżeń (`oknoLukKsef`).
 */
export function miesiaceAutomatu(dzien) {
  const [r, m] = String(dzien).split('-').map(Number);
  const poprzedni = m === 1 ? `${r - 1}-12` : `${r}-${String(m - 1).padStart(2, '0')}`;
  return [poprzedni, String(dzien).slice(0, 7)];
}

/**
 * Formularz ustawień. Pole ukryte `0` stoi przed polem wyboru `1`, więc zaznaczony przełącznik przychodzi jako
 * `['0','1']` — rozstrzyga ostatnia wartość. Wszystko inne odmawia (400), zamiast zgadywać.
 */
export function sprawdzFormularzAutomatu(body = {}) {
  const bledy = [];
  const wartosci = [].concat(body?.wlaczony ?? []);
  const ostatnia = wartosci.length ? String(wartosci[wartosci.length - 1]) : '';
  const poprawnyPrzelacznik = wartosci.every((w) => w === '0' || w === '1') && (ostatnia === '0' || ostatnia === '1');
  if (!poprawnyPrzelacznik) bledy.push('Przełącznik „Wysyłaj automatycznie” musi mieć wartość 1 albo 0.');
  const godzina = typeof body?.godzina === 'string' ? body.godzina : '';
  if (!WZOR_GODZINY.test(godzina)) bledy.push(`„${godzina}” to nie jest godzina w formacie GG:MM (00:00–${NAJPOZNIEJSZA_GODZINA}).`);
  else if (godzina > NAJPOZNIEJSZA_GODZINA) {
    bledy.push(`Najpóźniejsza godzina wysyłki to ${NAJPOZNIEJSZA_GODZINA} — zegar sprawdza porę co minutę, a przebieg musi zmieścić się przed północą.`);
  }
  return { wlaczony: ostatnia === '1', godzina, bledy };
}

/**
 * Dzień „ostatniego przebiegu” po zapisie ustawień. Włączenie albo zmiana godziny na już miniętą DZIŚ nie
 * wysyła od razu — oznacza dzisiejszy dzień jako zrobiony, pierwszy przebieg jutro. Człowiek, który włącza
 * automat o 21:30, nie spodziewa się wysyłki do KSeF w ciągu minuty. Zapis bez zmiany i wyłączenie nic nie ruszają.
 */
export function ostatniPrzebiegPoZapisie(poprzednio, nowe, chwila) {
  const zmiana = !poprzednio?.wlaczony || poprzednio?.godzina !== nowe.godzina;
  if (nowe.wlaczony && zmiana && chwila.godzina >= nowe.godzina) return chwila.dzien;
  return poprzednio?.ostatniPrzebieg ?? null;
}

/** Zdanie na ekran: kiedy automat ruszy (`null` — wyłączony). */
export function najblizszyPrzebieg(stan, chwila) {
  if (!stan?.wlaczony) return null;
  if (stan.ostatniPrzebieg === chwila.dzien) return `jutro o ${stan.godzina}`;
  if (chwila.godzina >= stan.godzina) return 'w ciągu minuty';
  return `dziś o ${stan.godzina}`;
}

// ── PRZ-123 C09: tryby wysyłki programu z własną wysyłką (TwojeFaktury) ─────────────────────────────────────────
// „reczna” (domyślnie) — automat nic nie robi; „po_wystawieniu” — co 5 minut, faktura idzie, gdy od zapisu jej
// OSTATNIEJ wersji minął odstęp na poprawki; „o_godzinie” — raz dziennie zbiorczo, jak automat inFaktu.
export const TRYBY_AUTOMATU = Object.freeze(['reczna', 'po_wystawieniu', 'o_godzinie']);
export const TRYB_DOMYSLNY = 'reczna';
export const ODSTEP_EDYCJI_DOMYSLNY = 15;
export const ODSTEP_EDYCJI_MAKS = 120;
/** Co ile minut idzie przebieg „po wystawieniu” (zegar tyka co minutę, przebieg — raz na takie okno). */
export const CO_ILE_PO_WYSTAWIENIU_MIN = 5;
const OKNO_MS = CO_ILE_PO_WYSTAWIENIU_MIN * 60_000;

/** Odstęp z bazy albo formularza: liczba całkowita 0–120, inaczej `null`. */
export function odstepEdycji(wartosc) {
  const tekst = String(wartosc ?? '').trim();
  if (!/^\d{1,3}$/u.test(tekst)) return null;
  const n = Number(tekst);
  return n <= ODSTEP_EDYCJI_MAKS ? n : null;
}

/** Początek 5-minutowego okna przebiegu (ms) — jeden przebieg „po wystawieniu” na okno. */
export const oknoPrzebiegu = (teraz) => Math.floor(teraz.getTime() / OKNO_MS) * OKNO_MS;

/** Czy od zapisu ostatniej wersji faktury minął odstęp na poprawki. Brak czasu wersji → nie (nie zgadujemy). */
export function poOdstepieEdycji(wersjaAt, odstepMin, teraz) {
  const t = Date.parse(String(wersjaAt ?? ''));
  if (!Number.isFinite(t)) return false;
  return teraz.getTime() >= t + odstepMin * 60_000;
}

/** Najwcześniejsza chwila wysyłki „po wystawieniu”: koniec odstępu zaokrąglony w górę do okna przebiegu. */
export function chwilaWysylkiPoWystawieniu(wersjaAt, odstepMin) {
  const t = Date.parse(String(wersjaAt ?? ''));
  if (!Number.isFinite(t)) return null;
  return new Date(Math.ceil((t + odstepMin * 60_000) / OKNO_MS) * OKNO_MS);
}

/** Formularz trybu (ekran automatu przy programie z własną wysyłką). Błąd → 400, nic nie zapisane. */
export function sprawdzFormularzTrybu(body = {}) {
  const bledy = [];
  const tryb = typeof body?.tryb === 'string' ? body.tryb : '';
  if (!TRYBY_AUTOMATU.includes(tryb)) bledy.push('Wybierz tryb wysyłki: ręcznie, po wystawieniu albo o godzinie.');
  const surowy = String(body?.odstep_edycji ?? '').trim();
  const odstep = surowy === '' ? ODSTEP_EDYCJI_DOMYSLNY : odstepEdycji(surowy);
  if (odstep === null) bledy.push(`Odstęp na poprawki to liczba pełnych minut od 0 do ${ODSTEP_EDYCJI_MAKS}.`);
  const godzina = typeof body?.godzina === 'string' ? body.godzina : '';
  if (!WZOR_GODZINY.test(godzina)) bledy.push(`„${godzina}” to nie jest godzina w formacie GG:MM (00:00–${NAJPOZNIEJSZA_GODZINA}).`);
  else if (godzina > NAJPOZNIEJSZA_GODZINA) {
    bledy.push(`Najpóźniejsza godzina wysyłki to ${NAJPOZNIEJSZA_GODZINA} — zegar sprawdza porę co minutę, a przebieg musi zmieścić się przed północą.`);
  }
  return { tryb, odstepEdycji: odstep ?? ODSTEP_EDYCJI_DOMYSLNY, godzina, bledy };
}
