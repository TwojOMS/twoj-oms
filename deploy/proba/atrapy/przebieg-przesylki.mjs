// PRZ-108.09 — wspólna część atrap kurierów (dpd.mjs, inpost.mjs): przebieg paczki w piaskownicy liczony od chwili, w której
// paczka powstała w bazie piaskownicy (`przesylki.utworzona_at`). Atrapa niczego nie nadaje (nadanie odmawia 400), więc
// paczkę „zna” tylko z bazy: rejestracja ręczna na karcie albo dane demo. Bez nadanej paczki w bazie — `null` (brak zdarzeń),
// jak prawdziwy kurier dla numeru, którego nie ma; odbioru bez nadania nie ma.
const MIN_MS = 60_000;

/**
 * Chwila utworzenia NADANEJ paczki kuriera `kurier` o numerze `numer` w bazie piaskownicy albo null.
 * `baza` to funkcja (baza otwiera się po złożeniu modułów — index.mjs); brak bazy = brak przebiegu.
 */
export function utworzeniePaczki(baza, { numer, kurier }) {
  const db = typeof baza === 'function' ? baza() : null;
  if (!db || !numer) return null;
  try {
    const w = db.prepare(`SELECT utworzona_at FROM przesylki WHERE numer_listu = ? AND kurier = ? AND status = 'nadana'
      ORDER BY id DESC LIMIT 1`).get(String(numer), kurier);
    const ms = Date.parse(w?.utworzona_at ?? '');
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null; // baza zamknięta (reset demo w toku) — jak kurier bez zdarzeń
  }
}

/** Zdarzenia przebiegu `[[minut po nadaniu, stan], …]`, które już nastąpiły do `terazMs`, z chwilą w ms. */
export function zdarzeniaDo(przebieg, utworzonaMs, terazMs) {
  if (!Number.isFinite(utworzonaMs) || !Number.isFinite(terazMs)) return [];
  return przebieg.map(([min, stan]) => ({ ms: utworzonaMs + min * MIN_MS, stan })).filter((z) => z.ms <= terazMs);
}
