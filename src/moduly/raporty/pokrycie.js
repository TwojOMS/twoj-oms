// PRZ-102.09: daty kompletności danych instalacji — z pliku konfiguracji albo z panelu (Finanse → Kompletność
// danych), zapis w tabeli `ustawienia` pod kluczem `raporty.<klucz>`. Plik wygrywa; panel czytany przy każdym
// użyciu, więc zapis działa bez restartu. Walidacja jak w konfiguracja.ts.
import { kluczOkresu } from '../../domena/okres-rozliczeniowy.js';

export const POLA_POKRYCIA = [
  { klucz: 'podlogaKosztow', env: 'OMS_RAPORTY_PODLOGA_KOSZTOW', typ: 'month', etykieta: 'Od którego miesiąca koszty w OMS-ie są kompletne?', opis: 'Pierwszy miesiąc z kompletem faktur kosztowych i kosztów ręcznych. Wcześniejszych miesięcy Finanse nie policzą.' },
  { klucz: 'podlogaZwrotow', env: 'OMS_RAPORTY_PODLOGA_ZWROTOW', typ: 'date', etykieta: 'Od którego dnia zwroty są kompletne?', opis: 'Początek znanej historii zwrotów w Raportach.' },
  { klucz: 'pierwszyDzienOms', env: 'OMS_STATYSTYKI_PIERWSZY_DZIEN', typ: 'date', etykieta: 'Od którego dnia dane statystyk są kompletne?', opis: 'Bez tej daty Statystyki przyjmują dzień pierwszego zamówienia w bazie.' },
];

export function pokrycieZPanelu(db, klucz) {
  return db.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?').get(`raporty.${klucz}`)?.wartosc || null;
}

/** Wartości z pliku zachowują pierwszeństwo; bazę czytamy dopiero przy użyciu konfiguracji. */
export function konfiguracjaZPokryciem(db, config) {
  const wynik = { ...config };
  for (const { klucz } of POLA_POKRYCIA) Object.defineProperty(wynik, klucz, {
    enumerable: true, get: () => config[klucz] ?? pokrycieZPanelu(db, klucz),
  });
  return wynik;
}

export function zapiszPokrycie(db, config, klucz, surowa) {
  const pole = POLA_POKRYCIA.find(p => p.klucz === klucz);
  if (!pole) return { kod: 400, blad: 'Nieznane ustawienie kompletności danych.' };
  if (config[klucz] !== null && config[klucz] !== undefined) return { kod: 409, blad: `${pole.env}: wartość ustala plik konfiguracji. Zmień ją w pliku i uruchom OMS ponownie.` };
  const wartosc = typeof surowa === 'string' ? surowa.trim() : '';
  try {
    if (pole.typ === 'month') {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(wartosc)) throw new Error();
    } else {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(wartosc)) throw new Error();
      kluczOkresu(wartosc);
    }
  } catch { return { kod: 400, blad: `Podaj poprawny ${pole.typ === 'month' ? 'miesiąc RRRR-MM' : 'dzień RRRR-MM-DD'}.` }; }
  db.prepare(`INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES (?, ?, ?)
    ON CONFLICT(klucz) DO UPDATE SET wartosc=excluded.wartosc, zmienione_at=excluded.zmienione_at`)
    .run(`raporty.${klucz}`, wartosc, new Date().toISOString());
  return { kod: 303 };
}
