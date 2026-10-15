import { metodaWysylki, punktOdbioru } from './wysylka.js';

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
// ⚠️ `metoda` (drugi argument, 2026-08-07) to metoda, ktora NAPRAWDE obsluzy to nadanie —
// nie zawsze ta z zamowienia. Przy zamowieniu z Allegro czlowiek wskazuje kuriera na ekranie
// nadania (domain/kurier-nadania.js), wiec `allegro_paczkomat` moze stac sie
// `inpost_paczkomat` i DOPIERO WTEDY kod paczkomatu staje sie obowiazkowy. Domyslka to
// metoda zamowienia, czyli dawne zachowanie dla wszystkich pozostalych wywolan.
//
// ⚠️ Przy zamowieniu allegrowym BEZ wskazanego kuriera ta funkcja oddaje `null`, i to jest
// poprawne, a nie luka: na tym etapie nie wiadomo jeszcze, czy paczka pojedzie do automatu,
// wiec zadanie „uzupelnij kod paczkomatu" byloby robota, ktorej moze wcale nie byc. Odmowe
// za brak wskazania niesie `metodaNadania`, wolane w services/nadanie.js PRZED kurierem.
export function powodBrakuGotowosciNadania(z, metoda = metodaWysylki(z)) {
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
