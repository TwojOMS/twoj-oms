// PRZ-092 — integracje skonfigurowane w Ustawieniach (tabela `konfiguracja_integracji`, migracja rdzenia 6).
//
// ⚠️ `sekrety` SĄ POŚWIADCZENIAMI (niezmiennik 4.10, jak `tokeny_kanalu`). `wczytajKonfiguracjeIntegracji`
// oddaje je dla budowy klienta integracji; ekran dostaje WYŁĄCZNIE `stanDlaEkranu` — same ustawienia jawne
// i nazwy zapisanych sekretów, nigdy ich wartości.

const json = (tekst) => {
  try { const v = JSON.parse(tekst); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
};

export function wczytajKonfiguracjeIntegracji(db, integracja) {
  const w = db.prepare('SELECT * FROM konfiguracja_integracji WHERE integracja = ?').get(integracja);
  if (!w) return null;
  return { ustawienia: json(w.ustawienia_json), sekrety: json(w.sekrety_json),
    zmienionoAt: w.zmieniono_at, kontoLogin: w.konto_login ?? null };
}

/** Ustawienia i sekrety zawsze RAZEM, jednym zapisem — połowa konfiguracji (nowy login, stare hasło) nie powstaje. */
export function zapiszKonfiguracjeIntegracji(db, integracja, { ustawienia, sekrety }, { konto = null, teraz = new Date() } = {}) {
  db.prepare(`INSERT INTO konfiguracja_integracji (integracja, ustawienia_json, sekrety_json, konto_id, konto_login, zmieniono_at)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(integracja) DO UPDATE SET ustawienia_json = excluded.ustawienia_json, sekrety_json = excluded.sekrety_json,
      konto_id = excluded.konto_id, konto_login = excluded.konto_login, zmieniono_at = excluded.zmieniono_at`)
    .run(integracja, JSON.stringify(ustawienia ?? {}), JSON.stringify(sekrety ?? {}),
      konto?.id ?? null, konto?.login ?? null, teraz.toISOString());
}

export function usunKonfiguracjeIntegracji(db, integracja) {
  return db.prepare('DELETE FROM konfiguracja_integracji WHERE integracja = ?').run(integracja).changes > 0;
}

/** Widok bez wartości sekretów: które są zapisane (true/false), kto i kiedy zmienił. */
export function stanDlaEkranu(zapis) {
  if (!zapis) return null;
  return { ustawienia: { ...zapis.ustawienia },
    zapisaneSekrety: Object.fromEntries(Object.entries(zapis.sekrety).map(([k, v]) => [k, Boolean(String(v ?? '').trim())])),
    zmienionoAt: zapis.zmienionoAt, kontoLogin: zapis.kontoLogin };
}
