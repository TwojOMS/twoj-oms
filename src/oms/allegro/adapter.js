import { mapujZamowienieAllegro } from '../../domena/allegro-mapowanie.js';
import { metodaZId } from '../../domena/allegro-dostawa.js';

// Adapter kanalu Allegro — TEN SAM kontrakt, co woo/adapter.js, wiec poller nie wie, z kim
// rozmawia (Zadanie 1). Reguly przebiegu (podloga po dacie zlozenia, jeden przebieg naraz,
// kursor za najpozniejsza PRZETWORZONA modyfikacja) zostaja przez to JEDNE dla wszystkich
// kanalow; ich druga kopia rozjechalaby sie po cichu, a pierwsza wersja kosztowala 8866
// wciagnietych zamowien (01.08.2026).
/** @param {import('../../integracje/opcje.ts').OpcjeAdapteraAllegro} opcje */
export function createAllegroAdapter({ klient }) {
  return {
    // ⚠️ `od` I `kursor` LECA OSOBNO, BEZ SKLEJANIA — inaczej niz w adapterze Woo, ktory robi
    // `kursor ?? od`. To nie jest niekonsekwencja: to klient Allegro WYBIERA miedzy dwoma
    // roznymi filtrami (`updatedAt.gte` albo `lineItems.boughtAt.gte` z sortowaniem) i musi
    // widziec PRAWDZIWY brak kursora. Podstawiona tu podloga znaczylaby, ze na pustym stanie
    // zawsze trafiamy w galaz „mam kursor" i pytamy o wszystko zmodyfikowane od daty
    // startowej — czyli o cale archiwum konta (775 zamowien w chwili rozpoznania).
    pobierzStrone: ({ od, kursor, strona }) => klient.pobierzZamowienia({ od, kursor, strona }),
    // ⚠️ `updatedAt` jest w UTC ze znacznikiem `Z` — pulapka stref czasu, ktora przy Woo
    // omal nie zgubila zamowien przy zmianie czasu (`date_modified` lokalne cofa sie
    // o godzine), tutaj NIE WYSTEPUJE. Kursor idzie za data MODYFIKACJI, nie zlozenia.
    kursorZ: (surowe) => surowe?.updatedAt ?? null,
    // Data ZLOZENIA, po ktorej idzie TRWALA PODLOGA. Allegro nie ma jej na poziomie
    // zamowienia — jest przy pierwszej pozycji (`lineItems[0].boughtAt`). Wartosc `null`
    // znaczy dla pollera „podloga nie obowiazuje", wiec pomylka w tym polu jest CICHA:
    // panel wciaga archiwum i nie zglasza zadnego bledu.
    zlozoneZ: (surowe) => surowe?.lineItems?.[0]?.boughtAt ?? null,
    // Slownik metod jest WSTRZYKIWANY do mapowania (domain/allegro-dostawa.js): mapowanie nie
    // ma prawa go znac, bo slownik sie zmienia, a regula mapowania nie.
    mapuj: (surowe) => mapujZamowienieAllegro(surowe, { metodaZId }),
  };
}
