// PRZ-121.01 — wybór modułu faktur (Ustawienia → Integracje → Moduł faktur albo OMS_PROGRAM_FAKTUROWY w pliku).
//
// Jedno źródło dla reguły (moduly/faktury/modul.ts), ekranu i zdań o wyłączonych fakturach. Decyzja właściciela P1
// (27.10.2026): „Jeżeli żaden moduł nie zostanie włączony, to nie ma opcji wystawiania fv”; inFakt jest modułem
// włączanym opcjonalnie.
//
// Reguła: plik → zapis z Ustawień → inFakt, gdy gotowy (klucz w pliku, zapis z ekranu przy starcie, atrapa, szew
// próby) → „brak”. Instalacja, która niczego nie wybrała, działa jak przed zmianą (źródło „domyslny”).
//   • Zła wartość w PLIKU = odmowa startu ze zdaniem z nazwą zmiennej (jak OMS_TRYB) — literówka zamieniona po cichu
//     na „brak” wyłączyłaby faktury w firmie bez śladu.
//   • Zła wartość w ZAPISIE (formularz jej nie przyjmie; zostaje po wycofaniu wydania, które znało więcej modułów)
//     = „brak” + uwaga. Odmowa startu położyłaby panel po wycofaniu, a inFakt wystawiałby faktury w programie,
//     którego nikt nie wybrał.
//   • Fakturownia i TwojeFaktury tylko z jawnego wyboru, nigdy domyślnie. Dziś „wkrótce” (`dostepny: false`) —
//     PRZ-119 / PRZ-122 odblokowują je jednym polem.
import { NAZWA_INFAKTU, EKRAN_INFAKTU } from './konfiguracja-infakt.js';

export const ZMIENNA_PROGRAMU = 'OMS_PROGRAM_FAKTUROWY';
/** Wiersz tabeli konfiguracja_integracji z zapisanym wyborem (ustawienia_json = {"program": "…"}, bez sekretów). */
export const KLUCZ_WYBORU_PROGRAMU = 'program_fakturowy';
export const EKRAN_WYBORU_PROGRAMU = '/ustawienia/integracje/program-fakturowy';

export const MODULY_FAKTUR = Object.freeze([
  Object.freeze({ id: 'brak', etykieta: 'Brak', dostepny: true }),
  Object.freeze({ id: 'infakt', etykieta: NAZWA_INFAKTU.mianownik, dostepny: true }),
  Object.freeze({ id: 'fakturownia', etykieta: 'Fakturownia', dostepny: false }),
  Object.freeze({ id: 'twojefaktury', etykieta: 'TwojeFaktury (program wbudowany)', dostepny: false }),
]);

const normalizuj = (v) => String(v ?? '').trim().toLowerCase();
const modul = (id) => MODULY_FAKTUR.find((m) => m.id === id) ?? null;
const dostepne = () => MODULY_FAKTUR.filter((m) => m.dostepny).map((m) => m.id);
const wkrotce = () => MODULY_FAKTUR.filter((m) => !m.dostepny).map((m) => m.id);

/** Etykieta modułu na ekran i do zdań („Brak”, „inFakt”…); nieznany identyfikator wraca bez zmian. */
export const etykietaModulu = (id) => modul(id)?.etykieta ?? String(id);

/**
 * OMS_PROGRAM_FAKTUROWY z pliku: pusta albo brak = `null` (plik nie wybiera), dostępny moduł = jego identyfikator
 * (wielkość liter i spacje bez znaczenia). Każda inna wartość — także moduł „wkrótce” — rzuca: panel nie wstaje.
 * @returns {string|null}
 */
export function wyborZPliku(wartosc) {
  const v = normalizuj(wartosc);
  if (!v) return null;
  if (modul(v)?.dostepny) return v;
  const lista = `${dostepne().join(' albo ')} (${wkrotce().join(', ')} — wkrótce)`;
  if (modul(v)) {
    throw new Error(`${ZMIENNA_PROGRAMU}: moduł faktur „${v}” będzie dostępny wkrótce, ta wersja OMS-u go nie ma — wpisz ${lista} lub usuń zmienną.`);
  }
  throw new Error(`${ZMIENNA_PROGRAMU}: nieznany moduł faktur „${String(wartosc).trim()}” — wpisz ${lista} lub usuń zmienną.`);
}

/** Uwaga dla zapisu, którego ta wersja nie obsługuje (ekran i Zdrowie). */
export const uwagaZlegoZapisu = (wartosc) =>
  `Zapisany moduł faktur „${String(wartosc ?? '').trim()}” nie działa w tej wersji OMS-u — faktury są wyłączone. Wybierz moduł ponownie.`;

/**
 * Reguła wyboru. `zPliku` — wynik `wyborZPliku` (już sprawdzony); `zUstawien` — surowa wartość z zapisu albo `null`,
 * gdy wiersza nie ma; `infaktGotowy` — inFakt dałby się złożyć bez wyboru (plik, zapis z ekranu, atrapa, szew próby).
 * @param {{ zPliku?: string|null, zUstawien?: string|null, infaktGotowy?: boolean }} [o]
 * @returns {{ program: string, zrodlo: 'plik'|'ustawienia'|'domyslny', uwaga: string|null }}
 */
export function wybierzProgram({ zPliku = null, zUstawien = null, infaktGotowy = false } = {}) {
  if (zPliku) return { program: zPliku, zrodlo: 'plik', uwaga: null };
  if (zUstawien !== null && zUstawien !== undefined) {
    const v = normalizuj(zUstawien);
    if (modul(v)?.dostepny) return { program: v, zrodlo: 'ustawienia', uwaga: null };
    return { program: 'brak', zrodlo: 'ustawienia', uwaga: uwagaZlegoZapisu(zUstawien) };
  }
  return { program: infaktGotowy ? 'infakt' : 'brak', zrodlo: 'domyslny', uwaga: null };
}

/**
 * Formularz ekranu: przyjmuje wyłącznie dostępny moduł (dziś „brak” albo „infakt”).
 * @returns {{ ustawienia: { program: string }, bledy: string[] }}
 */
export function sprawdzFormularzWyboru(body = {}) {
  const v = normalizuj(body?.program);
  if (modul(v)?.dostepny) return { ustawienia: { program: v }, bledy: [] };
  if (modul(v)) return { ustawienia: { program: v }, bledy: [`Moduł „${etykietaModulu(v)}” będzie dostępny wkrótce — wybierz inny.`] };
  return { ustawienia: { program: v }, bledy: ['Wybierz moduł faktur z listy.'] };
}

/** Czy faktury są wyłączone z wyboru człowieka (plik albo Ustawienia), a nie dlatego, że nic nie skonfigurowano. */
export const jawnyBrak = (wybor) => wybor?.program === 'brak' && (wybor.zrodlo === 'plik' || wybor.zrodlo === 'ustawienia');

/**
 * Zdanie „faktury wyłączone” — tylko przy JAWNYM „brak”. Przy „brak” domyślnym (nic nie wybrano, nic nie ma)
 * i przy każdym innym module `null`: wołający zostawia swój dotychczasowy tekst znak w znak. Zapis, którego ta wersja
 * nie zna, daje jego uwagę (faktury też są wyłączone). `dopisek` (np. „Nic nie poszło do programu.”) idzie po spacji.
 * @returns {string|null}
 */
export function zdanieBrakuProgramu(wybor, dopisek = '') {
  if (!jawnyBrak(wybor)) return null;
  const zdanie = wybor.uwaga ? wybor.uwaga
    : wybor.zrodlo === 'plik'
      ? `Faktury w OMS-ie są wyłączone — w pliku konfiguracji jest ${ZMIENNA_PROGRAMU}=brak.`
      : 'Faktury w OMS-ie są wyłączone — w Ustawienia → Integracje → Moduł faktur wybrano „Brak”.';
  return dopisek ? `${zdanie} ${dopisek}` : zdanie;
}

/**
 * Uwaga, gdy zapisany wybór różni się od działającego (zmiana działa po ponownym uruchomieniu OMS-u).
 * `null`, gdy nic nie czeka. Przy „brak” dopisek o automacie KSeF — ten staje od razu po zapisie.
 * Zapisany inFakt bez klucza (`gotowy` fałsz — ta sama gotowość co w regule) po restarcie też nie ruszy — wtedy zdanie o brakującym kluczu.
 */
export function zdanieCzekaniaNaRestart(dziala, zapisany, { gotowy = true } = {}) {
  if (!dziala || !zapisany || dziala.program === zapisany.program) return null;
  if (zapisany.program === 'infakt' && !gotowy) {
    const nazwa = etykietaModulu('infakt');
    return `Zapisany moduł faktur „${nazwa}” nie ma klucza API — wpisz go w Ustawienia → Integracje → ${nazwa} (${EKRAN_INFAKTU}); faktury ruszą po ponownym uruchomieniu OMS-u.`;
  }
  const automat = zapisany.program === 'brak' ? ' Automatyczna wysyłka do KSeF już stoi.' : '';
  const doTegoCzasu = dziala.program === 'brak' ? 'faktury są wyłączone' : `działa „${etykietaModulu(dziala.program)}”`;
  return `Zapisany moduł faktur „${etykietaModulu(zapisany.program)}” zadziała po ponownym uruchomieniu OMS-u — do tego czasu ${doTegoCzasu}.${automat}`;
}
