import { pobierzZamowienie, dopiszLog } from '../../../oms/db/zamowienia.js';
import { dodajDoKolejki } from '../db/kolejka-druku.js';

/**
 * „Nadaj i drukuj" znaczy „nadaj, A ETYKIETĘ WSTAW DO KOLEJKI" — nie „nadaj tylko wtedy, gdy
 * drukarka odpowiada". Paczka JUŻ ISTNIEJE fizycznie (numer listu jest zapisany), więc awaria
 * wstawienia do kolejki (baza, brak ZPL-a od kuriera) NIE MOŻE cofnąć ani zawiesić nadania —
 * zgaszony komputer produkcyjny nie ma prawa zatrzymać wysyłki. Dlatego funkcja nigdy nie rzuca.
 *
 * PRZ-070 (14.10.2026): przeniesione z trasy karty bez zmiany treści wpisów, bo od dziś woła to
 * też nadanie hurtem. Dwie kopie rozjechałyby się przy pierwszej poprawce — a to jest miejsce,
 * które rozstrzyga, czy pakowacz dostanie etykietę z drukarki.
 *
 * ⚠️ Paczka pod numerem `kolejnosc`, NIE „ostatnia w tabeli": przy dwóch paczkach nadanych
 * w odstępie chwili wybór po kolejności wierszy wstawiłby do kolejki cudzą etykietę.
 *
 * @returns {'w_kolejce' | 'brak_zpl' | 'blad'}
 */
export function wstawEtykieteDoKolejki(db, zamowienieId, kolejnosc, zrodlo) {
  try {
    const przesylka = pobierzZamowienie(db, zamowienieId)?.przesylki.find((p) => p.kolejnosc === kolejnosc);
    if (przesylka?.etykieta_zpl_sciezka) {
      dodajDoKolejki(db, przesylka.id);
      dopiszLog(db, zamowienieId, { akcja: 'kolejka-druku.dodanie', wynik: `OK (${zrodlo})` });
      return 'w_kolejce';
    }
    // Kurier nie oddał ZPL-a przy nadaniu (patrz services/nadanie.js) — nie ma czego wstawić.
    // To FAKT do zapisania, nie awaria: na karcie zostaje PDF, bez przycisku „Drukuj".
    dopiszLog(db, zamowienieId, { akcja: 'kolejka-druku.dodanie', wynik: `BRAK ZPL — nie dodano do kolejki (${zrodlo})` });
    return 'brak_zpl';
  } catch (e) {
    try {
      dopiszLog(db, zamowienieId, { akcja: 'kolejka-druku.dodanie', wynik: `BŁĄD: ${e.message}` });
    } catch {
      // Padł też zapis logu — nadanie i tak już stoi, a wynik „blad" trafia na ekran.
    }
    return 'blad';
  }
}
