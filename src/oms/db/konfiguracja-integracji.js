// Integracje skonfigurowane w Ustawieniach (tabela `konfiguracja_integracji`, migracja rdzenia 6).
//
// ⚠️ `sekrety` SĄ POŚWIADCZENIAMI (reguła: sekrety nie wychodzą; jak `tokeny_kanalu`). `wczytajKonfiguracjeIntegracji`
// oddaje je dla budowy klienta integracji; ekran dostaje WYŁĄCZNIE `stanDlaEkranu` — same ustawienia jawne
// i nazwy zapisanych sekretów, nigdy ich wartości.
//
// `sekrety_json` leży w bazie zaszyfrowany kluczem poświadczeń (src/core/bezpieczenstwo/sejf-sekretow.js);
// obiekt bez kluczy zostaje jawnym `{}` — wiersze bez sekretów nie potrzebują klucza. Odczyt jest twardy:
// wartość nieczytelna to BladSekretow, nigdy pusta konfiguracja.

import { BladSekretow, doZapisu, klasyfikuj, sejfBazy } from '../../core/bezpieczenstwo/sejf-sekretow.js';

const json = (tekst) => {
  try {
    const v = JSON.parse(tekst);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
};

export const miejsceSekretowIntegracji = (integracja) => ({
  tabela: 'konfiguracja_integracji',
  kolumna: 'sekrety_json',
  id: integracja,
});

/** Sekrety wiersza: `{}` dla pustego, odszyfrowany obiekt dla szyfrogramu, BladSekretow dla wszystkiego innego. */
export function sekretyZOdczytu(db, integracja, zapis) {
  if (klasyfikuj(zapis, { json: true }) === 'pusty') return {};
  const miejsce = miejsceSekretowIntegracji(integracja);
  const tekst = sejfBazy(db).odszyfruj(zapis, miejsce);
  let v;
  try {
    v = JSON.parse(tekst);
  } catch {
    v = null;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new BladSekretow(
      'USZKODZONY',
      `Sekrety integracji ${JSON.stringify(String(integracja))} po odszyfrowaniu nie są obiektem JSON.`,
      { tabela: miejsce.tabela, wiersz: String(integracja) },
    );
  }
  return v;
}

/** Tekst do kolumny `sekrety_json`: `{}` dla obiektu bez kluczy, szyfrogram całego JSON-a w pozostałych. */
export function sekretyDoZapisu(db, integracja, sekrety) {
  const obiekt = sekrety ?? {};
  return Object.keys(obiekt).length
    ? doZapisu(db, miejsceSekretowIntegracji(integracja), JSON.stringify(obiekt))
    : '{}';
}

export function wczytajKonfiguracjeIntegracji(db, integracja) {
  const w = db.prepare('SELECT * FROM konfiguracja_integracji WHERE integracja = ?').get(integracja);
  if (!w) return null;
  return {
    ustawienia: json(w.ustawienia_json),
    sekrety: sekretyZOdczytu(db, integracja, w.sekrety_json),
    zmienionoAt: w.zmieniono_at,
    kontoLogin: w.konto_login ?? null,
  };
}

/** Ustawienia i sekrety zawsze RAZEM, jednym zapisem — połowa konfiguracji (nowy login, stare hasło) nie powstaje. */
export function zapiszKonfiguracjeIntegracji(
  db,
  integracja,
  { ustawienia, sekrety },
  { konto = null, teraz = new Date() } = {},
) {
  db.prepare(
    `INSERT INTO konfiguracja_integracji (integracja, ustawienia_json, sekrety_json, konto_id, konto_login, zmieniono_at)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(integracja) DO UPDATE SET ustawienia_json = excluded.ustawienia_json, sekrety_json = excluded.sekrety_json,
      konto_id = excluded.konto_id, konto_login = excluded.konto_login, zmieniono_at = excluded.zmieniono_at`,
  ).run(
    integracja,
    JSON.stringify(ustawienia ?? {}),
    sekretyDoZapisu(db, integracja, sekrety),
    konto?.id ?? null,
    konto?.login ?? null,
    teraz.toISOString(),
  );
}

export function usunKonfiguracjeIntegracji(db, integracja) {
  return db.prepare('DELETE FROM konfiguracja_integracji WHERE integracja = ?').run(integracja).changes > 0;
}

/** Widok bez wartości sekretów: które są zapisane (true/false), kto i kiedy zmienił. */
export function stanDlaEkranu(zapis) {
  if (!zapis) return null;
  return {
    ustawienia: { ...zapis.ustawienia },
    zapisaneSekrety: Object.fromEntries(
      Object.entries(zapis.sekrety).map(([k, v]) => [k, Boolean(String(v ?? '').trim())]),
    ),
    zmienionoAt: zapis.zmienionoAt,
    kontoLogin: zapis.kontoLogin,
  };
}
