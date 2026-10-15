import { parsujPaczke, parsujPaczkeInpost } from './paczka.js';
import { profilGabarytuAllegro, parsujGabarytAllegro } from './gabaryty-allegro.js';

// PRZ-070: rozmiar paczki w nadaniu HURTEM — wybór w wierszu podglądu (decyzja właściciela 14.10:
// „w DPD wybór rozmiaru z zapisanych szablonów paczki", paczkomat A/B/C, automat S/M/L).
//
// ⚠️ ŻADNEGO WŁASNEGO PARSERA. Paczka powstaje TYMI SAMYMI funkcjami, co na karcie
// (`parsujPaczke`, `parsujPaczkeInpost`, `parsujGabarytAllegro`) — inaczej hurt przyjmowałby
// wartości, których karta odmawia, a adapter kuriera zobaczyłby inny kształt niż z karty.

const szablonDomyslny = (szablony) => szablony.szablony.find((s) => s.id === szablony.domyslnyId);

// Limit wagi automatów Allegro — ten sam, którego pilnuje `parsujGabarytAllegro`.
const MAKS_WAGA_AUTOMATU = 20;

/** Co ekran podglądu wstawi w wiersz jako wybór wstępny. */
export function domyslnyRozmiarWiersza({ rodzaj, deliveryMethodId = null, szablony }) {
  const domyslny = szablonDomyslny(szablony);
  if (rodzaj === 'paczkomat') return { pole: 'gabaryt', gabaryt: 'A', waga: domyslny.waga };
  const profil = rodzaj === 'wza' ? profilGabarytuAllegro(deliveryMethodId) : null;
  if (profil) {
    return {
      pole: 'gabarytAllegro',
      gabaryt: profil.domyslnyGabaryt ?? 'S',
      // Waga płaskiego arkusza z szablonu domyślnego bywa większa niż limit automatu —
      // propozycja, której parser i tak by odmówił, kazałaby człowiekowi poprawiać ekran.
      waga: profil.domyslnaWaga ?? Math.min(domyslny.waga, MAKS_WAGA_AUTOMATU),
      gabaryty: Object.keys(profil.gabaryty),
    };
  }
  return { pole: 'szablon', szablon: domyslny.id };
}

/** Pola JEDNEGO wiersza z formularza zatwierdzenia — klucze niosą identyfikator zamówienia. */
export function polaWiersza(body, id) {
  return {
    szablon: body?.[`szablon_${id}`],
    gabaryt: body?.[`gabaryt_${id}`],
    waga: body?.[`waga_${id}`],
  };
}

/**
 * Paczka wiersza: `{ paczka }` albo `{ blad }` — odmowa dotyczy TEGO wiersza, nie partii.
 *
 * ⚠️ BRAK POLA SZABLONU = SZABLON DOMYŚLNY, i to jest zgodność wstecz, nie wygoda: formularz
 * sprzed PRZ-070 (otwarta zakładka, stara karta) niesie same identyfikatory i do tej pory
 * nadawał DPD wymiarami domyślnymi. Gabarytu paczkomatu i automatu NIE zgadujemy — tamtych
 * wierszy stary formularz w ogóle nie znał, a za ciasna skrytka to odrzucona paczka.
 */
export function paczkaWiersza({ rodzaj, deliveryMethodId = null, pola = {}, szablony }) {
  const domyslny = szablonDomyslny(szablony);
  if (rodzaj === 'paczkomat') {
    return parsujPaczkeInpost({ waga: domyslny.waga, gabaryt: pola.gabaryt });
  }
  if (rodzaj === 'wza' && profilGabarytuAllegro(deliveryMethodId)) {
    return parsujGabarytAllegro({ gabaryt: pola.gabaryt, waga: pola.waga }, deliveryMethodId);
  }
  const id = pola.szablon == null || pola.szablon === '' ? szablony.domyslnyId : String(pola.szablon);
  const s = szablony.szablony.find((x) => x.id === id);
  // Szablon skasowany albo przemianowany między podglądem a zatwierdzeniem: cichy powrót do
  // domyślnego dałby paczkę o wymiarach, których człowiek na ekranie NIE wybrał.
  if (!s) return { blad: 'Szablon paczki zmienił się — odśwież podgląd nadania.' };
  const { paczka, blad } = parsujPaczke({
    waga: s.waga, dlugosc: s.dlugosc, szerokosc: s.szerokosc, wysokosc: s.wysokosc,
  });
  if (blad) return { blad };
  // Jak na karcie (trasy/nadanie.js): adapter WzA porównuje usługę z tej chwili z tą z ekranu.
  return { paczka: rodzaj === 'wza' ? { ...paczka, oczekiwanyDeliveryMethodId: deliveryMethodId } : paczka };
}
