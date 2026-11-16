import { metodaWysylki, punktOdbioru, czyPobranie } from './wysylka.js';
import { powodOdmowyPobraniaGrupy } from './scalanie.js';
import { uwagaDolaczonychAnulowanych } from './status.js';

/**
 * Czego zamowieniu BRAKUJE, zeby dalo sie je w ogole nadac.
 *
 * Zwraca gotowy komunikat dla czlowieka albo `null`, gdy nie brakuje niczego.
 *
 * ⚠️ ISTNIEJE PO TO, ZEBY ODMOWA BYLA WIDOCZNA ZANIM KTOS KLIKNIE „NADAJ". Sam wyjatek
 * w services/nadanie.js by wystarczyl do BEZPIECZENSTWA, ale nie do uczciwosci: karta
 * pokazywalaby przycisk „Nadaj paczke", ekran nadania wypelnilby komplet pol, operator
 * spakowalby paczke — i dopiero zatwierdzenie powiedzialoby mu, ze panel nigdy nie mial
 * jak jej wyslac. To ta sama zasada, co przy odbiorze osobistym na karcie („ekran nadania
 * istnieje po to, zeby NIE klamac") — tylko tam brakuje kuriera, a tu adresu.
 *
 * Odpowiedz jest JEDNA dla wszystkich trzech czytelnikow (karta, ekran nadania, usluga
 * nadania), bo trzy kopie tego samego warunku rozjechalyby sie przy pierwszej zmianie
 * i panel zaczalby proponowac akcje, ktora sam odrzuca.
 */
// ⚠️ `metoda` (drugi argument) to metoda, która NAPRAWDĘ obsłuży to nadanie —
// nie zawsze ta z zamówienia. Przy zamówieniu z Allegro człowiek wskazuje kuriera na ekranie
// nadania (domena/kurier-nadania.js), więc `allegro_paczkomat` może stać się
// `inpost_paczkomat` i DOPIERO WTEDY kod paczkomatu staje się obowiązkowy. Domyślnie to
// metoda zamówienia, czyli dawne zachowanie dla wszystkich pozostałych wywołań.
//
// ⚠️ Przy zamówieniu allegrowym BEZ wskazanego kuriera ta funkcja oddaje `null`, i to jest
// poprawne, a nie luka: na tym etapie nie wiadomo jeszcze, czy paczka pojedzie do automatu,
// więc żądanie „uzupełnij kod paczkomatu” byłoby robotą, której może wcale nie być. Odmowę
// za brak wskazania niesie `metodaNadania`, wołane w moduly/wysylka/services/nadanie.js PRZED kurierem.
export function powodBrakuGotowosciNadania(z, metoda = metodaWysylki(z)) {
  // Dołączone jedzie w paczce głównego (adres i paczka zawsze z głównego). Ta funkcja
  // stoi przed nadaniem z karty, z ekranu nadania, hurtem i w samej usłudze (services/nadanie.js).
  if (z?.scalone_do) {
    return `Zamówienie jest scalone z zamówieniem ${z.scalone_do_numer ?? `#${z.scalone_do}`} — paczkę nadajesz z zamówienia głównego.`;
  }
  // Paczka grupy wiozłaby pozycje anulowanego dołączonego — ten sam
  // warunek, co odmowa faktury grupy (`sprawdzCzlonkowGrupy`).
  const anulowaneDolaczone = uwagaDolaczonychAnulowanych(z);
  if (anulowaneDolaczone) return `Nie nadasz paczki: ${anulowaneDolaczone}.`;
  // OBRONA W GŁĘBI. Pobrania na zamówieniu scalonym nie da się ustawić
  // (karta, „Przywróć metodę”), ale stan sprzed poprawki albo ręczna zmiana bazy dałyby paczkę za
  // pobraniem na kwotę jednego zamówienia, choć jedzie w niej cała grupa.
  if (czyPobranie(z)) {
    const pobranieGrupy = powodOdmowyPobraniaGrupy(z);
    if (pobranieGrupy) return pobranieGrupy;
  }
  // Kod paczkomatu jest ADRESEM przesylki, nie jej ozdoba: bez niego InPost nie ma dokad
  // jej nadac. Klient ShipX odmowilby i tak (kurierzy/inpost.js), ale dopiero PO zajeciu
  // miejsca w indeksie i po zapakowaniu paczki.
  //
  // Sytuacja jest ZYCIOWA, a nie brzegowa: klient bywa, ze poda kod w uwagach zamiast
  // wybrac paczkomat w checkoucie — wtedy w kolumnie nie ma nic, a nadac trzeba. Dlatego
  // komunikat mowi, GDZIE ten kod wpisac, zamiast samego „nie da sie".
  if (metoda === 'inpost_paczkomat' && !String(punktOdbioru(z) ?? '').trim()) {
    return 'To zamówienie ma jechać do paczkomatu, ale nie ma kodu paczkomatu — bez niego nie wiadomo, '
      + 'dokąd nadać paczkę. Uzupełnij kod przy metodzie wysyłki (Szczegóły → Edytuj); klient bywa, '
      + 'że podaje go w uwagach zamiast wybierać paczkomat w sklepie.';
  }
  return null;
}
