import { drogaErliDlaZamowienia } from '../../kanaly/services/kanal-erli.ts';
import { saNadpisanieWysylki } from '../../../domena/wysylka.js';
import { kurierzyDoWyboru } from '../../../domena/kurier-nadania.js';

// null oznacza zwykłą metodę OMS (także ręczną). Blokada ERLI jest rozstrzygana
// przed wyborem alternatywy: nie wolno zgadywać nieznanego cennika.
export function metodaNadaniaErli(db, z, wybor = '', opcje = {}) {
  if (saNadpisanieWysylki(z)) return null;
  let droga;
  try {
    droga = drogaErliDlaZamowienia(db, z);
  } catch (e) {
    // Baza bez tabeli kanałów (np. sam moduł wysyłki) nie ma kanału ERLI, więc to zwykła metoda OMS.
    if (/no such table: kanaly_sprzedazy/.test(String(e?.message))) return null;
    throw e;
  }
  if (droga === undefined) return null;
  if (!droga) return { blad: 'ERLI: słowniki metod dostawy nie są jeszcze gotowe — nadanie zablokowane.' };
  if (droga.droga === 'blokada') return { blad: droga.komunikat };
  if (droga.droga === 'umowa' && droga.kurier === 'odbior') return { blad: 'Odbiór osobisty — do tego zamówienia nie jedzie żadna paczka, nie ma czego nadawać.' };
  const metoda = droga.droga === 'przesylki_erli' ? 'erli_przesylki' : droga.kurier;
  const wskazany = String(wybor ?? '').trim();
  if (wskazany && wskazany !== metoda) {
    const dozwolone = kurierzyDoWyboru(z, opcje.kolejnosc, opcje);
    if (!dozwolone.some(k => k.klucz === wskazany)) return { blad: 'ERLI: wskazany kurier nie jest dostępny dla tej paczki.' };
    return { metoda: wskazany, wskazanyRecznie: true };
  }
  // Pobranie zamówienia ERLI pochodzi z `delivery.cod` (erli-mapowanie.js), a ręczna zmiana pobrania
  // kończy drogę ERLI wyżej (saNadpisanieWysylki) — osobna kontrola pobrania nie ma tu czego łapać.
  return { metoda };
}
