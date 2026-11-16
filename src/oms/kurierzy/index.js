import { bladOperatora } from '../../domena/bledy.js';
import { kurierDlaMetody, KURIER_DOMYSLNY } from '../../domena/moduly-kurierow.ts';

// Reszta modułu nie wie, który kurier jest podpięty.
//
// Mapa „metoda → kurier” (dawniej stała `DLA_METODY`; pod tą nazwą występuje jeszcze w testach
// i w zamowienie.ejs) to `metody` kurierów w rejestrze `MODULY_KURIEROW` (domena/moduly-kurierow.ts),
// czytane przez `kurierDlaMetody`. Zasada: BRAK METODY W REJESTRZE = ODMOWA NADANIA.
//
// UWAGA `odbior_osobisty` CELOWO NIE MA WPISU. Brak wpisu to nie przeoczenie, tylko
// mechanizm odmowy: wybierzKuriera rzuca na nieznanej metodzie, więc sprzedaż na miejscu
// nie ma jak wygenerować paczki. Dopisanie jej = paczka do klienta, który stoi
// przy ladzie, za którą zapłacimy i której nie da się cofnąć.
//
// ⚠️ NIE MA TU `dpd_pobranie` i to nie jest przeoczenie: pobranie
// nie jest metodą wysyłki, tylko flagą obok niej. Ten sam kurier obsługuje
// paczkę z inkasem i bez — różnica siedzi w kopercie (<cod> w kurierzy/dpd.js), a nie
// w tym, do kogo dzwonimy.
// ⚠️ `inpost_paczkomat` prowadzi do kuriera `inpost` (moduly/wysylka/kurierzy.ts składa go
// pod tą samą nazwą). Bez skonfigurowanego klienta ShipX wybierzKuriera odmawia — jedyna
// uczciwa odpowiedź panelu brzmi wtedy „nie umiem tego nadać”.
// ⚠️⚠️ METODY ALLEGROWE WŁĄCZAJĄ WYDAWANIE PIENIĘDZY: `allegro_dpd`, `allegro_punkt`,
// `allegro_kurier` i `allegro_inne` prowadzą do kuriera `allegro_wza`, który kupuje przewóz
// NA UMOWIE ALLEGRO — tę samą usługę, którą wybrał kupujący, więc i z zachowanym Smart.
//
// ⚠️ `allegro_paczkomat` wpisu NIE MA i brak jest mechanizmem odmowy, nie przeoczeniem.
// Paczkomat z Allegro to usługa o `owner: CLIENT` (domena/allegro-wysylka.js) —
// Allegro wystawia ją na NASZEJ umowie InPostu, więc nadanie jej przez WzA byłoby drugim,
// płatnym przewozem. ⛔ `allegro_paczkomat` nadajemy sami (`NADAJEMY_SAMI`
// w domena/kurier-nadania.js → `inpost_paczkomat`).
// ⚠️⚠️ METODY ALLEGROWE PROWADZĄ WYŁĄCZNIE DO ADAPTERA WzA, NIGDY DO NASZEGO KURIERA.
// To rozróżnienie jest całą ochroną przed drugim, płatnym przewozem: WzA kupuje etykietę
// na umowie ALLEGRO (przesyłka, którą kupujący ma już opłaconą), a `dpd`/`inpost` nadają
// na NASZEJ. Usługi WzA są w `METODY_WZA` (domena/allegro-wysylka.js).

/**
 * Kurier dla przesyłki nadanej POZA panelem (wpis ręczny, moduly/wysylka/trasy/nadanie.js).
 *
 * Różni się od `wybierzKuriera` dwiema rzeczami i obie są celowe:
 *  - NIE wymaga skonfigurowanego klienta — panel niczego tu nie nada, tylko odnotowuje fakt;
 *  - NIE RZUCA na nieznanej metodzie, bo zamówienie „bez metody” jest tu przypadkiem
 *    NAJCZĘSTSZYM: właśnie takie nadaje się z ręki.
 *
 * ⚠️ Kurier NIE MOŻE być wpisany na sztywno. Wiersz przesyłki steruje
 * linkiem do śledzenia i wyborem usługi statusu, więc stałe `'dpd'` znaczyłoby, że paczkomat nadany
 * w Managerze Paczek InPostu linkuje na tracktrace.dpd.com.pl i pyta DPD o numer InPostu.
 * Zapasowy `KURIER_DOMYSLNY` z rejestru (dziś 'dpd') zostaje WYŁĄCZNIE dla metody nieznanej.
 *
 * ⚠️ KANAŁ ALLEGRO MA WŁASNĄ WARTOŚĆ `'allegro'` — i to NIE JEST metoda
 * w rejestrze kurierów. Rejestr steruje NADAWANIEM; tutaj chodzi wyłącznie o ODNOTOWANIE faktu
 * o paczce, która już jedzie. Bez tego warunku zapasowe 'dpd' brałoby numer listu z Allegro
 * („AD…”) i linkowało go na tracktrace.dpd.com.pl, a pętla odświeżania pytałaby DPD o CUDZĄ
 * przesyłkę. Ręczny wpis
 * jest dostępny od chwili, gdy zamówienia Allegro pojawią się na liście, więc ten warunek
 * musi stać razem z kanałem, a nie razem z przesyłkami.
 *
 * `'allegro'` ma w mapie kurierów tylko klienta ODCZYTU (kurierzy/allegro.js, podpinany
 * w moduly/wysylka/kurierzy.ts): panel niczego nim nie nada, ale pyta Allegro o status paczki.
 *
 * ⚠️ LINK DO ŚLEDZENIA liczy `linkSledzeniaPaczki` (domena/przewoznik-przesylki.js) z prawdziwego
 * przewoźnika paczki. Gdy przewoźnika nie da się ustalić, link jest `null`, a `lista-ikony.js`
 * robi `href: sledzenie ?? '/zamowienia/<id>'`, więc ikona prowadzi wtedy do KARTY
 * ZAMÓWIENIA, czyli do linku, który na pewno działa — nigdy do zgadniętego adresu.
 */
export function kurierWpisuRecznego(metoda) {
  if (String(metoda ?? '').startsWith('allegro_')) return 'allegro';
  return kurierDlaMetody(metoda) ?? KURIER_DOMYSLNY;
}

/**
 * @param {string} metoda
 * @param {import('../../moduly/wysylka/kurierzy.ts').MapaKurierow} kurierzy
 */
export function wybierzKuriera(metoda, kurierzy) {
  const nazwa = kurierDlaMetody(metoda);
  if (!nazwa) throw bladOperatora(`Metoda „${metoda}” nie jest obsługiwana w tym panelu.`);
  const k = kurierzy?.[nazwa];
  if (!k) throw bladOperatora(`Kurier ${nazwa} nie jest skonfigurowany.`);
  return { nazwa, klient: k };
}
