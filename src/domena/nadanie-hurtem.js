import { parsujPaczke, parsujPaczkeInpost } from './paczka.js';
import { profilGabarytuAllegro, parsujGabarytAllegro } from './gabaryty-allegro.js';
import { propozycjaAutomatu } from './gabaryty-automatow.js';

// PRZ-070: rozmiar paczki w nadaniu HURTEM — wybór w wierszu podglądu (decyzja właściciela 14.10:
// „w DPD wybór rozmiaru z zapisanych szablonów paczki", paczkomat A/B/C, automat S/M/L).
//
// ⚠️ ŻADNEGO WŁASNEGO PARSERA. Paczka powstaje TYMI SAMYMI funkcjami, co na karcie
// (`parsujPaczke`, `parsujPaczkeInpost`, `parsujGabarytAllegro`) — inaczej hurt przyjmowałby
// wartości, których karta odmawia, a adapter kuriera zobaczyłby inny kształt niż z karty.

const szablonDomyslny = (szablony) => szablony.szablony.find((s) => s.id === szablony.domyslnyId);

// PRZ-157.12r: wartość pola szablonu „wymiary z kreatora kanału” (krok 4 ERLI). Szablony operatora mają
// identyfikatory UUID albo 'domyslna', więc ten napis z nimi nie koliduje.
export const SZABLON_KANALU = 'erli';
// Wartość niesie wymiary z podglądu: zatwierdzenie porównuje je z krokiem 4 z tej chwili, więc zmiana
// w kreatorze między podglądem a zatwierdzeniem odrzuca wiersz zamiast nadać paczkę, której nikt nie widział.
export const wartoscSzablonuKanalu = (w) => `${SZABLON_KANALU}:${w.dlugosc}x${w.szerokosc}x${w.wysokosc}x${w.waga}`;

// PRZ-152.G11c: gabaryt i waga paczkomatu / automatu Allegro z ustawienia „Paczkomaty i automaty”
// — `propozycjaAutomatu`, TA SAMA funkcja, z której bierze karta nadania (trasy/nadanie.js).
// `ustawienia` to zapis `wczytajUstawienia` — ten sam, z którego trasa czyta `szablony`;
// domena bazy nie czyta.

/** Co ekran podglądu wstawi w wiersz jako wybór wstępny. */
export function domyslnyRozmiarWiersza({ rodzaj, deliveryMethodId = null, szablony, ustawienia, wymiaryKanalu = null }) {
  const domyslny = szablonDomyslny(szablony);
  // PRZ-157.12r: Przesyłki Erli — wybór wstępny to wymiary z kroku 4 kreatora (jak formularz karty);
  // szablony operatora zostają na liście, więc człowiek może podać inne. Trasa podaje je tylko
  // dla metody `erli_przesylki` (formularz kurierski), więc rodzaju tu nie sprawdzamy.
  if (wymiaryKanalu) return { pole: 'szablon', szablon: wartoscSzablonuKanalu(wymiaryKanalu), kanal: wymiaryKanalu };
  if (rodzaj === 'paczkomat') {
    const { gabaryt, waga } = propozycjaAutomatu(ustawienia, { rodzaj });
    return { pole: 'gabaryt', gabaryt, waga };
  }
  const profil = rodzaj === 'wza' ? profilGabarytuAllegro(deliveryMethodId) : null;
  const propozycja = profil ? propozycjaAutomatu(ustawienia, { rodzaj, deliveryMethodId }) : null;
  if (propozycja) {
    return {
      pole: 'gabarytAllegro',
      gabaryt: propozycja.gabaryt,
      waga: propozycja.waga,
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
export function paczkaWiersza({ rodzaj, deliveryMethodId = null, pola = {}, szablony, ustawienia, wymiaryKanalu = null }) {
  if (rodzaj === 'paczkomat') {
    // Wiersz paczkomatu nie ma pola wagi (ekran pokazuje ją tekstem) — waga z ustawienia,
    // tej samej propozycji, którą pokazał podgląd; od G11 nie z szablonu kuriera.
    return parsujPaczkeInpost({ waga: propozycjaAutomatu(ustawienia, { rodzaj }).waga, gabaryt: pola.gabaryt });
  }
  if (rodzaj === 'wza' && profilGabarytuAllegro(deliveryMethodId)) {
    return parsujGabarytAllegro({ gabaryt: pola.gabaryt, waga: pola.waga }, deliveryMethodId);
  }
  // PRZ-157.12r: wiersz Przesyłek Erli bez pola albo z „wymiarami z ERLI” = wymiary z kroku 4 kreatora.
  const bezPola = pola.szablon == null || pola.szablon === '';
  const zKanalu = String(pola.szablon ?? '').split(':')[0] === SZABLON_KANALU;
  if (zKanalu || (bezPola && wymiaryKanalu)) {
    if (!wymiaryKanalu || (zKanalu && pola.szablon !== wartoscSzablonuKanalu(wymiaryKanalu))) {
      return { blad: 'Wymiary paczki z ustawień kanału zmieniły się — odśwież podgląd nadania.' };
    }
    return parsujPaczke({
      waga: wymiaryKanalu.waga, dlugosc: wymiaryKanalu.dlugosc, szerokosc: wymiaryKanalu.szerokosc, wysokosc: wymiaryKanalu.wysokosc,
    });
  }
  const id = bezPola ? szablony.domyslnyId : String(pola.szablon);
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
