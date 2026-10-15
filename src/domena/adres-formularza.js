import { POLA_WYMAGANE_PRZEZ_DPD } from './adres-odbiorcy.js';

// Adres odbiorcy Z FORMULARZA ekranu nadania (POST /zamowienia/:id/nadaj).
//
// Od chwili, gdy adres na ekranie stał się edytowalny, TO jest miejsce, w którym powstaje
// adres, który naprawdę pojedzie do DPD — nie adresOdbiorcy(zamowienie) (ta zostaje wyłącznie
// źródłem WARTOŚCI STARTOWYCH formularza na GET). Trasa POST bierze to, co ta funkcja zwróci,
// i przekazuje DALEJ bez ponownego czytania z zamówienia — patrz komentarz w kurierzy/dpd.js
// i services/nadanie.js. Gdyby POST po cichu wrócił do zamówienia (np. „na wszelki wypadek"),
// poprawka operatora byłaby POZORNA: ekran pokazywałby jeden adres, a do kuriera pojechałby inny.
const ETYKIETY_POL = { ulica: 'ulica', kod: 'kod pocztowy', miasto: 'miasto' };

function tekst(surowa) {
  const t = String(surowa ?? '').trim();
  return t || null;
}

/**
 * Zwraca { adres } gotowy do przekazania do nadanie.nadaj()/klient.nadaj(), albo { blad }
 * z czytelnym komunikatem, gdy którekolwiek pole WYMAGANE PRZEZ DPD (patrz
 * domain/adres-odbiorcy.js — POLA_WYMAGANE_PRZEZ_DPD, JEDNO źródło prawdy dla obu miejsc)
 * jest puste. Puste pole wymagane to ZAWSZE odmowa, NIGDY ciche przepuszczenie do DPD —
 * dawniej (przed edytowalnym adresem) to samo ostrzeżenie tylko podświetlało pole w widoku
 * i NIE blokowało zatwierdzenia; teraz musi, bo operator mógł je wyczyścić przez przypadek.
 */
export function parsujAdresOdbiorcy(dane) {
  const nazwa = tekst(dane?.nazwa) ?? '';
  const adres = {
    nazwa,
    // Fallback firmy na imię i nazwisko — dokładnie ten sam, co w adresOdbiorcy(): DPD
    // wymaga niepustego pola company na etykiecie, a klient go nie zawsze poda.
    company: tekst(dane?.company) || nazwa,
    ulica: tekst(dane?.ulica),
    kod: tekst(dane?.kod),
    miasto: tekst(dane?.miasto),
    // Kraj NIE jest polem operatora — formularz go niesie jako ukryte pole (patrz nadaj.ejs),
    // wypełnione na GET z adresOdbiorcy(zamowienie). Brak pola w ogóle (np. wywołanie spoza
    // HTTP) domyślnie znaczy 'PL', spójnie z adresOdbiorcy().
    kraj: tekst(dane?.kraj) || 'PL',
    phone: tekst(dane?.phone),
    email: tekst(dane?.email),
  };

  const brakujace = POLA_WYMAGANE_PRZEZ_DPD.filter((pole) => !adres[pole]);
  if (brakujace.length) {
    return {
      blad: `Adres odbiorcy: brakuje pola ${brakujace.map((p) => ETYKIETY_POL[p]).join(', ')} `
        + '— DPD tego wymaga do nadania. Uzupełnij adres w formularzu przed zatwierdzeniem.',
    };
  }
  return { adres };
}
