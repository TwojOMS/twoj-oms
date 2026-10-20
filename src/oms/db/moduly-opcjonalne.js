import { dozwolonyModul, parsujWylaczoneModuly } from '../../domena/moduly-opcjonalne.js';
import { stanFakturyOkresu } from '../../domena/okres-rozliczeniowy.js';
import { saldoOkresuGrosze } from '../../domena/saldo-okresu.js';
import { podzialZamowienOkresu, sumaOczekiwanaOkresuGrosze } from '../../moduly/faktury/services/faktura-okresu.js';
import { zamowieniaOkresu } from './okresy.js';
import { pobierzZamowienie } from './zamowienia.js';
import { wplatyOkresu } from './platnosci.js';

const KLUCZ = 'moduly.wylaczone';
// PRZ-102.22: chwila ostatniego włączenia Kosztów — /health liczy od niej próg nocnego pobrania (domena/zdrowie.js).
const KLUCZ_KOSZTY_WLACZONE = 'moduly.koszty.wlaczone_at';
export const kosztyWlaczoneOd = (db) => db.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?').get(KLUCZ_KOSZTY_WLACZONE)?.wartosc ?? null;
export function wylaczoneModuly(db) {
  return parsujWylaczoneModuly(db.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?').get(KLUCZ)?.wartosc);
}

export function zaleznosciModulow(db) {
  const zbiorczy = db.prepare('SELECT COUNT(*) AS n FROM klienci WHERE rozliczenie_zbiorcze = 1').get().n;
  const rabaty = db.prepare('SELECT COUNT(*) AS n FROM klienci WHERE rabat_procent > 0').get().n;
  let okresy = 0, nierozliczoneOkresy = 0, bledneKwotyOkresow = 0;
  // Również pusty okres może przechowywać zaliczkę po odpięciu zamówień.
  for (const okres of db.prepare('SELECT * FROM okresy_rozliczeniowe').all()) {
    const wszystkie = zamowieniaOkresu(db, okres.id).map(id => pobierzZamowienie(db, id));
    const { zamowienia } = podzialZamowienOkresu(wszystkie);
    const wplaty = wplatyOkresu(db, okres.id);
    const wystawiona = stanFakturyOkresu(okres) === 'wystawiona';
    if (wszystkie.length && !wystawiona) okresy++;
    try {
      // Te same dane i arytmetyka co daneOkresu/rozliczenieOkresu w trasie okresów.
      const kwotaFakturyGr = sumaOczekiwanaOkresuGrosze(zamowienia);
      const saldo = saldoOkresuGrosze({ kwotaFakturyGr, wplaty });
      if ((wystawiona && saldo.stan !== 'pokryte') || (!wszystkie.length && wplaty.length)) nierozliczoneOkresy++;
    } catch {
      // Nieczytelna kwota nie jest dowodem rozliczenia — ekran musi pozostać dostępny.
      nierozliczoneOkresy++;
      bledneKwotyOkresow++;
    }
  }
  // PRZ-102.22: koszty z ostatnich 60 dni (data wystawienia) — przy przełączniku Kosztów, nie blokuje wyłączenia.
  const od = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
  const kosztyOstatnie = db.prepare('SELECT COUNT(*) AS n FROM koszty WHERE data_wystawienia >= ?').get(od).n;
  return { zbiorczy, rabaty, okresy, nierozliczoneOkresy, bledneKwotyOkresow, kosztyOstatnie };
}

export function przelaczModul(db, { modul, wlacz }) {
  if (!dozwolonyModul(modul) || typeof wlacz !== 'boolean') return { kod: 400, blad: 'Nieznany moduł albo niepoprawna wartość przełącznika.' };
  db.exec('BEGIN IMMEDIATE');
  try {
    const zaleznosci = zaleznosciModulow(db);
    const powody = [];
    // Bezpiecznik rozliczeń dotyczy Stałych klientów i Rozliczeń. Koszty to widok i pobieranie — wyłączenie nie
    // rusza danych (PRZ-102.22), więc nie blokuje go nic.
    const chroniony = modul === 'klienci' || modul === 'okresy';
    if (chroniony && !wlacz && zaleznosci.zbiorczy > 0) powody.push(`${zaleznosci.zbiorczy} stałych klientów z rozliczeniem zbiorczym — wymagają edycji warunków na karcie klienta i fakturowania w Rozliczeniach`);
    if (chroniony && !wlacz && zaleznosci.okresy > 0) powody.push(`${zaleznosci.okresy} okresów z zamówieniami bez zakończonej faktury — potrzebne są Rozliczenia oraz karta klienta do uzupełnienia nabywcy i warunków umowy`);
    if (chroniony && !wlacz && zaleznosci.nierozliczoneOkresy > 0) powody.push(`${zaleznosci.nierozliczoneOkresy} okresów z nierozliczonymi wpłatami albo niedopłatą — rozlicz je w Rozliczeniach`);
    if (chroniony && !wlacz && zaleznosci.bledneKwotyOkresow > 0) powody.push(`${zaleznosci.bledneKwotyOkresow} okresów: nie można odczytać kwoty zamówienia lub wpłaty — sprawdź i popraw dane w Rozliczeniach`);
    if (powody.length) {
      db.exec('ROLLBACK');
      return { kod: 409, blad: `Nie można wyłączyć modułu: ${powody.join('; ')}.` };
    }
    const lista = wylaczoneModuly(db).filter(k => k !== modul);
    if (!wlacz) lista.push(modul);
    db.prepare(`INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES (?, ?, ?)
      ON CONFLICT(klucz) DO UPDATE SET wartosc=excluded.wartosc, zmienione_at=excluded.zmienione_at`)
      .run(KLUCZ, JSON.stringify(lista), new Date().toISOString());
    if (modul === 'koszty' && wlacz) {
      db.prepare(`INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES (?, ?, ?)
        ON CONFLICT(klucz) DO UPDATE SET wartosc=excluded.wartosc, zmienione_at=excluded.zmienione_at`)
        .run(KLUCZ_KOSZTY_WLACZONE, new Date().toISOString(), new Date().toISOString());
    }
    db.exec('COMMIT');
    return { kod: 303 };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
