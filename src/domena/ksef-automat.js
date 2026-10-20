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
