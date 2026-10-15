import { ofertyDoSprawdzenia, zapiszProbeZdjecia } from '../../../oms/db/zdjecia-ofert.js';
import { zdjecieOferty } from '../../../domena/miniatury.js';

// ZDJĘCIA OFERT ALLEGRO — dociągane POZA zapisem zamówienia, tym samym wzorcem, co numery
// listów przewozowych (services/przesylki-allegro.js).
//
// ⚠️⚠️ KIEDY PYTAMY: W PRZEBIEGU POLLERA, o oferty, których jeszcze nie znamy.
// NIE przy otwarciu karty — i to jest rozstrzygnięcie, nie wygoda:
//
//   * MINIATURY WIDAĆ NA LIŚCIE, nie tylko na karcie (kolumna „Produkty", lista.ejs).
//     Pobieranie „przy otwarciu karty" znaczyłoby, że oferta, której karty nikt nie otworzył,
//     nie ma miniatury na liście NIGDY — czyli lista wyglądałaby na „częściowo zadziałało",
//     dokładnie tak, jak wyglądały miniatury sklepowe przed przeliczeniem wstecz (db/db.js).
//   * LISTA RENDERUJE SIĘ SYNCHRONICZNIE i pokazuje kilkadziesiąt pozycji naraz. Zapytanie
//     do Allegro w tej ścieżce znaczyłoby kilkadziesiąt żądań na jedno wejście na stronę
//     główną — a przy milczącym Allegro pusty ekran zamiast listy roboczej (niezmiennik 4.9).
//   * PRZEBIEG POLLERA JUŻ ROZMAWIA Z ALLEGRO, ma własną blokadę „jeden naraz" i chodzi
//     w tle, gdzie nikt na niego nie patrzy. To jest jedyne miejsce w panelu, w którym
//     czekanie na Allegro nic nie kosztuje.
//
// ⚠️ RUCH SPADA DO ZERA SAM. Pytamy WYŁĄCZNIE o oferty spoza pamięci podręcznej, a produktów
// są dziesiątki. Po kilku przebiegach pamięć jest pełna i kolejne tyknięcia zegara robią jedno
// zapytanie do WŁASNEJ bazy i ani jednego do Allegro — nowa oferta pojawia się tylko razem
// z nowym produktem.

// ⚠️ ILE OFERT NA JEDEN PRZEBIEG. Nie jest to ostrożność na zapas: pierwszy przebieg po
// wdrożeniu widzi CAŁE archiwum kanału naraz (775 zamówień w chwili rozpoznania), więc bez
// ograniczenia jedno tyknięcie zegara zamieniłoby się w setki żądań w jednej serii.
//
// 20 × 5 s (LIMIT_ZAPYTANIA_OFERTY_MS) to najgorszy przypadek nieco ponad półtorej minuty,
// czyli mniej niż odstęp między tyknięciami — a przy odpowiadającym Allegro to sekundy.
// Dziesiątki produktów znaczą, że pamięć i tak zapełnia się w kilku przebiegach.
export const LIMIT_OFERT_NA_PRZEBIEG = 20;

export function createZdjeciaAllegro({ db, klienci = {}, limitNaPrzebieg = LIMIT_OFERT_NA_PRZEBIEG }) {
  // ⚠️ JEDEN PRZEBIEG NARAZ — ta sama zasada i ten sam powód, co w services/poller.js.
  // Uzupełnianie jest doczepione do przebiegu pollera, a ten bywa wołany także ręcznie
  // (przycisk „Synchronizuj"); dwa uzupełnienia naraz pytałyby Allegro o TE SAME oferty,
  // bo żadne z nich nie zdążyłoby jeszcze zapisać wyniku.
  let wTrakcie = false;

  /**
   * Dociąga zdjęcia ofert, których pamięć podręczna jeszcze nie zna — dla KAŻDEGO kanału
   * osobno, bo `GET /sale/product-offers/{id}` oddaje wyłącznie własną ofertę zalogowanego
   * sprzedawcy.
   *
   * ⚠️ NIE RZUCA NIGDY. Awaria pojedynczej oferty jest zapisywana jako fakt o TEJ ofercie
   * i pętla idzie dalej — to ta sama izolacja per rekord, co przy mapowaniu zamówień
   * w pollerze (services/poller.js), i z tego samego powodu: jedna oferta o złym kształcie
   * nie ma prawa zabrać miniatur wszystkim pozostałym.
   *
   * ⚠️ ŚWIADOMA ASYMETRIA WOBEC `przesylki-allegro.js`, KTÓRA BŁĘDÓW NIE POŁYKA. Tam awaria
   * kanału była nieodróżnialna od „ta paczka nie ma jeszcze numeru", czyli od stanu
   * normalnego, więc musiała dojść do wołającego. Tutaj brak zdjęcia JEST stanem normalnym
   * i nic nie znaczy — miniatura jest ozdobą, a nazwa produktu stoi obok niej tak czy
   * inaczej. Ślad po nieudanej próbie zostaje w `zdjecia_ofert.blad`, czyli tam, gdzie go
   * szuka diagnozujący, i NIE trafia do `stan_pollera.ostatni_blad`: pasek na liście
   * zamówień jest jedynym miejscem, w którym widać awarię SYNCHRONIZACJI, i wypisanie tam
   * usterki kosmetycznej zamieniłoby go w szum.
   */
  async function uzupelnij() {
    if (wTrakcie) return { pobrane: 0, bezZdjecia: 0, nieudane: 0, pominiety: true };
    wTrakcie = true;
    let pobrane = 0;
    let bezZdjecia = 0;
    let nieudane = 0;
    try {
      for (const [kanal, klient] of Object.entries(klienci)) {
        // Kanał skonfigurowany do odczytu zamówień, ale bez tej metody u klienta, to tryb
        // POPRAWNY (ta sama zasada, co przy braku klienta w przesylki-allegro.js): panel
        // po prostu nie pyta, zamiast wywalać się na `undefined.pobierzOferte`.
        if (typeof klient?.pobierzOferte !== 'function') continue;
        const oferty = ofertyDoSprawdzenia(db, kanal, { limit: limitNaPrzebieg });
        for (const ofertaId of oferty) {
          try {
            const oferta = await klient.pobierzOferte(ofertaId);
            // `null` znaczy „Allegro odpowiedziało, a oferta zdjęcia nie ma" — ZAPISUJEMY to
            // jako odpowiedź (pusty adres, pusty błąd), żeby nie pytać o nią drugi raz.
            const adres = zdjecieOferty(oferta);
            zapiszProbeZdjecia(db, ofertaId, { zdjecieUrl: adres });
            if (adres) pobrane += 1; else bezZdjecia += 1;
          } catch (e) {
            // ⚠️ Do komunikatu idzie WYŁĄCZNIE `message` klienta (kod HTTP i ścieżka —
            // nigdy token ani ciało odpowiedzi), tak samo jak przy błędach pollera.
            zapiszProbeZdjecia(db, ofertaId, { blad: e?.message ? String(e.message) : String(e) });
            nieudane += 1;
          }
        }
      }
    } finally {
      // `finally`, nie koniec `try`: przerwane uzupełnianie MUSI zwolnić blokadę, inaczej
      // jedna awaria wycisza miniatury na zawsze — cicho, bo panel dalej działa.
      wTrakcie = false;
    }
    return { pobrane, bezZdjecia, nieudane };
  }

  return { uzupelnij };
}

/**
 * Doczepia uzupełnianie zdjęć do przebiegu pollera.
 *
 * ⚠️ AWARIA POBIERANIA ZDJĘĆ NIE MA PRAWA DOTKNĄĆ PRZEBIEGU — ani jego wyniku, ani kursora,
 * ani ani jednego zamówienia. Stąd trzy rzeczy naraz, i każda jest konieczna:
 *
 *   1. `finally` — zdjęcia dociągają się TAKŻE wtedy, gdy przebieg rzucił. Awaria jednego
 *      kanału (wygasły refresh token, 500 z Allegro) nie ma powodu zabierać miniatur
 *      pozostałym, a przebieg zbiorczy (bootstrap.js) rzuca po przejściu WSZYSTKICH pollerów.
 *   2. wewnętrzny `try/catch` — wyjątek rzucony w `finally` PODMIENIŁBY błąd przebiegu na
 *      swój własny: awaria synchronizacji zamówień zniknęłaby z paska na liście, a w jej
 *      miejsce stanęłaby usterka kosmetyczna. `uzupelnij` sama błędów nie wypuszcza, ale ten
 *      warunek ma trzymać się kodu, a nie obietnicy z innego pliku.
 *   3. wynik przebiegu wraca NIETKNIĘTY — wołający (bootstrap, trasa „Synchronizuj") widzi
 *      dokładnie to, co widział przed tą zmianą.
 */
export function zPobieraniemZdjec(poller, zdjecia) {
  return {
    ...poller,
    przebieg: async (...argumenty) => {
      try {
        return await poller.przebieg(...argumenty);
      } finally {
        try {
          await zdjecia.uzupelnij();
        } catch {
          // Ślad po nieudanej próbie leży w `zdjecia_ofert.blad` przy KONKRETNEJ ofercie —
          // patrz uzasadnienie przy `uzupelnij`. Tutaj nie ma czego dopisać poza szumem.
        }
      }
    },
  };
}
