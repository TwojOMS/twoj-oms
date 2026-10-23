// PRZ-108.08 (zmiana C1 planu automatyzacji): sprawdzacz warunków w chwili wykonania dla silnika — świeże zamówienie
// z bazy (tym samym odczytem co karta) i czysta reguła domeny (domena/warunki-automatyzacji.js). Etykiety statusów
// z Ustawień, żeby powód w dzienniku mówił „Czeka na klosz”, a nie klucz.
// Poprawki po recenzji 08: najpierw „mail do historii” (zamówienie wysłane albo złożone przed włączeniem reguły) — ta
// reguła nie zależy od warunków ustawionych w regule, obowiązuje każdą.
import { pobierzZamowienie } from '../../../oms/db/zamowienia.js';
import { etykietyStatusow } from '../../../oms/db/statusy.js';
import { sprawdzWarunki, historiaPrzedGranica, importSpozniony } from '../../../domena/warunki-automatyzacji.js';
import { odbiorSpozniony } from '../../../domena/dowod-odbioru.js';

export async function sprawdzanieWarunkow({ db, regula, wykonanie }) {
  const z = pobierzZamowienie(db, wykonanie.zamowienie_id);
  // PRZ-108.08b (R2-1): wykonanie niesie paczkę i chwilę zdarzenia — numer z Allegro dociągnięty długo po złożeniu.
  const historia = historiaPrzedGranica(z, regula.granica, { wykonanie });
  if (!historia.ok) return historia;
  // PRZ-108.09 (recenzja 09, usterka 1): „Kurier odebrał paczkę” z dowodem spóźnionym o ponad 48 h → pominięte z powodem.
  // Wybór: warunek wykonania, nie filtr detektora — odbiór zostaje w historii paczki, a dziennik reguły mówi, dlaczego
  // maila nie było (filtr w SQL milczałby). Tylko dla tego zdarzenia: „Paczka nadana” na tej samej paczce nie zależy od odbioru.
  if (regula.zdarzenie === 'paczka_odebrana') {
    const odbior = odbiorSpozniony(z, wykonanie);
    if (!odbior.ok) return odbior;
  }
  if (regula.zdarzenie === 'zamowienie_nowe') {
    const importZamowienia = importSpozniony(z, wykonanie);
    if (!importZamowienia.ok) return importZamowienia;
  }
  return sprawdzWarunki(z, regula.warunki, { etykiety: etykietyStatusow(db) });
}
