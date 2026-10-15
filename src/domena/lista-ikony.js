// Cztery ikony wiersza listy (Zadanie „strona główna", punkt C). Widok NIE liczy tego
// sam — ta sama zasada, co przy stanie przesyłki i fakturze na karcie (przewodnik OMS,
// sekcja 3): decyzja domenowa ma brzmieć tak samo na liście i na karcie, więc mieszka
// w jednym miejscu. Każda funkcja oddaje `stan` (krótki klucz, widok dobiera po nim
// kolor/kształt) i `opis` — opis jest OBOWIĄZKOWY, bo sam kolor nie może nieść znaczenia
// („zielone kółko" nie mówi nic komuś, kto widzi to pierwszy raz, ani czytnikowi ekranu).
//
// Na dole pliku mieszka jeszcze `odznakaSyncStatusu` — nie ikona, tylko krótka odznaka
// tekstowa wiersza. Stoi tu, bo to ta sama warstwa i ta sama zasada: co widać na liście,
// liczy domena, a nie szablon.
import { linkDoSledzenia } from './tracking.js';
import { chceFakture } from './dane-faktury.js';
import { stanFaktury } from './faktura-stan.js';
import { fmtDataCzas } from './format-daty.js';
import { czyPobranie, czyKanalAllegro } from './wysylka.js';

/**
 * Płatność. Pobranie WYGRYWA nad opłacone/nieopłacone: przy wysyłce za pobraniem brak
 * wpłaty jest stanem NORMALNYM (kurier inkasuje przy doręczeniu), nie problemem — karta
 * zamówienia (zamowienie.ejs) NIE ostrzega o braku wpłaty przy pobraniu z dokładnie tego
 * samego powodu. Obie strony pytają TĘ SAMĄ funkcję `czyPobranie` (od 2026-08-01 pobranie
 * to osobna wartość, nie nazwa metody) — gdyby ikona liczyła to sama, lista kłamałaby karcie.
 *
 * `z.oplacone_at` czytamy WPROST — to już FAKT WYLICZANY z listy wpłat (zLinii w
 * db/zamowienia.js, przewodnik OMS 4.1), nie surowa kolumna sklepu.
 */
export function ikonaPlatnosci(z) {
  if (czyPobranie(z)) {
    return { stan: 'pobranie', opis: 'Płatność: za pobraniem — kurier zainkasuje przy doręczeniu.' };
  }
  // Data W OPISIE tez idzie przez formatowanie. Opis ikony jest tekstem dla czlowieka
  // dokladnie tak samo jak komorka tabeli — surowy znacznik ISO w UTC ("...T18:11:48.883Z")
  // pokazywalby w dymku inna godzine niz reszta panelu, i to o dwie godziny.
  if (z?.oplacone_at) {
    return { stan: 'oplacone', opis: `Płatność: opłacone (${fmtDataCzas(z.oplacone_at)}).` };
  }
  return { stan: 'nieoplacone', opis: 'Płatność: nieopłacone.' };
}

/**
 * Przesyłka. Zielona TYLKO gdy istnieje NUMER LISTU przewozowego — sam wiersz w
 * `przesylki` (np. stan 'w_trakcie' albo 'zawieszona') numeru może jeszcze nie mieć.
 * Link buduje WYŁĄCZNIE `linkDoSledzenia` (domain/tracking.js) — ta funkcja go nie
 * skleja, żeby adres śledzenia miał JEDNO źródło prawdy wspólne z kartą zamówienia.
 *
 * Kilka paczek naraz: z poziomu listy nie da się wybrać „której" — link prowadzi
 * do karty zamówienia, nie do śledzenia pierwszej z brzegu.
 *
 * `zewnetrzny` mówi widokowi, że adres wychodzi POZA panel (śledzenie u kuriera) — taki
 * otwiera się w nowej karcie, żeby lista robocza nie znikała operatorowi spod ręki. Adresy
 * własne panelu (karta zamówienia) zostają w tej samej karcie: nowa byłaby uciążliwa
 * i niespójna z numerem zamówienia obok. Rozróżnienie stoi TUTAJ, a nie w widoku po
 * kształcie adresu — inaczej szablon zgadywałby regułę z `startsWith('http')`.
 */
export function ikonaPrzesylki(z) {
  const paczki = (z?.przesylki ?? []).filter((p) => p.numer_listu);
  if (paczki.length === 0) {
    return { stan: 'brak', opis: 'Przesyłka: brak numeru listu przewozowego.', href: null, zewnetrzny: false };
  }
  if (paczki.length === 1) {
    const [p] = paczki;
    const sledzenie = linkDoSledzenia(p.kurier, p.numer_listu);
    return {
      stan: 'nadana',
      opis: `Przesyłka: numer listu ${p.numer_listu}.`,
      href: sledzenie ?? `/zamowienia/${z.id}`,
      zewnetrzny: Boolean(sledzenie),
    };
  }
  return {
    stan: 'nadana',
    opis: `Przesyłka: ${paczki.length} paczki — szczegóły na karcie zamówienia.`,
    href: `/zamowienia/${z.id}`,
    zewnetrzny: false,
  };
}

/**
 * Faktura chciana — TA SAMA funkcja `chceFakture` co karta i fakturowanie
 * (domain/dane-faktury.js), NIGDY surowa kolumna `chce_fakture`: ręczny przełącznik
 * musi wygrywać tu dokładnie tak samo, jak wygrywa wszędzie indziej w module.
 */
export function ikonaChceFaktury(z) {
  return chceFakture(z)
    ? { stan: 'tak', opis: 'Faktura: klient chce fakturę.' }
    : { stan: 'nie', opis: 'Faktura: klient nie chce faktury.' };
}

// Opisy stanów rezerwacji faktury — poza funkcją, żeby test i ewentualny drugi
// czytelnik (np. karta, gdyby kiedyś chciała tego samego skrótu) mogły go współdzielić.
const OPISY_FAKTURY = {
  brak: 'Faktura: nie wystawiona.',
  w_toku: 'Faktura: wystawianie trwa.',
  zawieszona: 'Faktura zawieszona — sprawdź w inFakcie.',
  do_wyjasnienia: 'Faktura do wyjaśnienia — sprawdź w inFakcie.',
};

/**
 * Faktura wystawiona — TA SAMA funkcja `stanFaktury` co karta i lista robocza
 * (domain/faktura-stan.js). Trzy stany pośrednie ('w_toku', 'zawieszona',
 * 'do_wyjasnienia') NIE są tym samym co „brak" — to sprawy wymagające człowieka
 * (przewodnik OMS 4.9) i dostają WŁASNY opis, żeby nie zniknęły pod jednym „nie ma".
 */
export function ikonaFaktury(z) {
  const stan = stanFaktury(z?.faktura);
  if (stan === 'wystawiona') {
    const numer = z?.faktura?.numer;
    return { stan, opis: `Faktura: wystawiona${numer ? ` (${numer})` : ''}.` };
  }
  return { stan, opis: OPISY_FAKTURY[stan] };
}

/**
 * Odznaka wiersza: status zamówienia NIE DOJECHAŁ tam, skąd zamówienie przyszło
 * (`zamowienia.sync_woo_blad`). Oddaje krótki tekst albo `null`.
 *
 * ⚠️ K1 (recenzja Partii 1 Planu B). Od tej samej zmiany taki ślad TRZYMA zamówienie na
 * liście roboczej (domain/status.js → doZrobienia) — a stan, który wraca na listę bez
 * podanego powodu, jest tylko innym rodzajem ciszy. Ta sama konstrukcja, co przy sprawach
 * przesyłki (`sprawyZamowienia`): tekst liczy DOMENA, widok go nie skleja.
 *
 * ⚠️ BRZMIENIE PO KANALE, NIE PO NAZWIE KOLUMNY — dokładnie jak na pasku karty
 * (domain/sprawy-karty.js) i tym samym predykatem (`czyKanalAllegro`). „Do sklepu" przy
 * zamówieniu z Allegro wysyłałoby operatora szukać usterki w WooCommerce, gdzie tego
 * zamówienia NIE MA.
 */
export function odznakaSyncStatusu(z) {
  if (!z?.sync_woo_blad) return null;
  return czyKanalAllegro(z) ? 'status nie dojechał do Allegro' : 'status nie dojechał do sklepu';
}
