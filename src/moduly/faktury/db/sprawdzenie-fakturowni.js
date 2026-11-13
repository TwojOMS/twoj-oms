// PRZ-161 — wynik ostatniego sprawdzenia połączenia z Fakturownią (przy zapisie i przyciskiem „Sprawdź połączenie”).
//
// Ekran mówi „Podłączony” TYLKO wtedy, gdy Fakturownia przyjęła token. Wynik jest przypięty odciskiem do domeny
// i tokenu, z którymi go uzyskano: zmiana danych (nowy token, inna domena, zapis z pominięciem ekranu) unieważnia
// go bez osobnego kasowania. Odcisk to skrót SHA-256 — z niego nie da się odtworzyć tokenu, a token i tak leży
// w tej samej bazie (`konfiguracja_integracji`).
//
// Magazyn: tabela `ustawienia` (klucz niżej, wartość JSON) — bez nowej tabeli i migracji, jak alarm auto-KSeF.
import { createHash } from 'node:crypto';

export const KLUCZ_SPRAWDZENIA_FAKTUROWNI = 'faktury.fakturownia.sprawdzenie';
/** `ok` — Fakturownia przyjęła token; `odrzucony` — odmówiła (4xx); `niesprawdzony` — brak odpowiedzi albo pominięte. */
export const STANY_SPRAWDZENIA = Object.freeze(['ok', 'odrzucony', 'niesprawdzony']);

export function odciskDanychFakturowni({ domena, token } = {}) {
  return createHash('sha256').update(`${String(domena ?? '')}\n${String(token ?? '')}`).digest('hex').slice(0, 32);
}

/** Zapis wyniku: `{ stan, tekst }` dla danych `{ domena, token }`. Tekst już bez tokenu i domeny (maskuje moduł). */
export function zapiszSprawdzenieFakturowni(db, { stan, tekst = null }, dane, { teraz = new Date() } = {}) {
  if (!STANY_SPRAWDZENIA.includes(stan)) throw new Error(`zapiszSprawdzenieFakturowni: nieznany stan ${stan}`);
  const kiedy = teraz.toISOString();
  db.prepare(`INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES (?, ?, ?)
    ON CONFLICT(klucz) DO UPDATE SET wartosc = excluded.wartosc, zmienione_at = excluded.zmienione_at`)
    .run(KLUCZ_SPRAWDZENIA_FAKTUROWNI, JSON.stringify({ stan, tekst, kiedy, odcisk: odciskDanychFakturowni(dane) }), kiedy);
}

/** Wynik dla OBECNYCH danych albo null (brak wyniku, zepsuty zapis, inne dane niż przy sprawdzeniu). */
export function wczytajSprawdzenieFakturowni(db, dane) {
  const w = db.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?').get(KLUCZ_SPRAWDZENIA_FAKTUROWNI);
  if (!w?.wartosc || !dane) return null;
  let v;
  try { v = JSON.parse(w.wartosc); } catch { return null; }
  if (!v || !STANY_SPRAWDZENIA.includes(v.stan) || v.odcisk !== odciskDanychFakturowni(dane)) return null;
  return { stan: v.stan, tekst: v.tekst ?? null, kiedy: v.kiedy ?? null };
}

export function usunSprawdzenieFakturowni(db) {
  db.prepare('DELETE FROM ustawienia WHERE klucz = ?').run(KLUCZ_SPRAWDZENIA_FAKTUROWNI);
}

/**
 * Błąd sprawdzenia → stan. Odmowa Fakturowni (4xx poza 429: zły token, brak dostępu, nieznane konto) = `odrzucony`
 * — tych danych nie zapisujemy. Brak odpowiedzi, limit czasu, 429, 5xx, nierozpoznana odpowiedź = `niesprawdzony`
 * — dane mogą być dobre, a Fakturownia chwilowo niedostępna.
 */
export function stanZBledu(e) {
  const s = Number(e?.status);
  return Number.isInteger(s) && s >= 400 && s < 500 && s !== 429 ? 'odrzucony' : 'niesprawdzony';
}
