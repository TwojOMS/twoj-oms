// PRZ-119.03 — trwały alarm „Fakturownia sama wysłała dokument do KSeF”.
//
// Wystawienie w Fakturowni NIE może wysyłać do KSeF (wysyłka to osobny, zatwierdzany krok). Jeśli konto ma włączoną
// automatyczną wysyłkę, odpowiedź na wystawienie niesie `gov_status` inny niż null / not_connected / not_applicable.
// Wtedy dokument JUŻ jest (nie cofamy go, kolejne wystawienia idą dalej), ale operator musi to zobaczyć i sprawdzić
// ustawienia konta. Alarm gaśnie WYŁĄCZNIE przyciskiem „Sprawdziłem” (`zgas`) — czyste wystawienie go nie gasi.
//
// Magazyn: tabela `ustawienia` (klucz poniżej, wartość = JSON tablicy wpisów) — bez nowej tabeli i migracji.

export const KLUCZ_ALARMU_AUTO_KSEF = 'faktury.fakturownia.alarm-auto-ksef';

const NIECZYTELNY = Object.freeze({
  dokument: null, numer: null, gov_status: 'nieczytelny zapis alarmu', oid: null, chwila: null,
});

function odczytaj(db) {
  const w = db.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?').get(KLUCZ_ALARMU_AUTO_KSEF);
  if (!w || w.wartosc == null || w.wartosc === '') return [];
  try {
    const dane = JSON.parse(w.wartosc);
    if (Array.isArray(dane)) return dane;
  } catch { /* niżej */ }
  // Zepsuty zapis NIE gasi alarmu po cichu — świeci jako jeden wpis „nieczytelny”, aż operator go zgasi.
  return [{ ...NIECZYTELNY }];
}

function zapisz(db, wpisy, chwila) {
  db.prepare(`INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES (?, ?, ?)
    ON CONFLICT(klucz) DO UPDATE SET wartosc = excluded.wartosc, zmienione_at = excluded.zmienione_at`)
    .run(KLUCZ_ALARMU_AUTO_KSEF, JSON.stringify(wpisy), chwila);
}

/** Magazyn alarmu na bazie OMS: `dopisz(wpis)`, `wczytaj()`, `zgas()` (tylko „Sprawdziłem”). */
export function utworzAlarmAutoKsef(db, { teraz = () => new Date() } = {}) {
  return Object.freeze({
    dopisz(wpis) {
      const chwila = teraz().toISOString();
      const dokument = wpis?.dokument == null ? null : String(wpis.dokument);
      const wpisy = odczytaj(db).filter((w) => dokument === null || w?.dokument !== dokument);
      wpisy.push({
        dokument, numer: wpis?.numer ?? null, gov_status: wpis?.gov_status ?? null, oid: wpis?.oid ?? null, chwila,
      });
      zapisz(db, wpisy, chwila);
    },
    wczytaj() {
      return odczytaj(db);
    },
    zgas() {
      zapisz(db, [], teraz().toISOString());
    },
  });
}
