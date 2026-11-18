// Plik przygotowawczy vitest (setupFiles): domyślny sejf poświadczeń dla testów, które otwierają bazę przez
// `openOmsDb` bez środowiska. Kod produkcyjny takiego sejfu nie ma — strażnik
// (tests/core/bezpieczenstwo/straznik-sekretow.test.js) zabrania `ustawSejfDomyslny` w src/, scripts/ i deploy/.
// Test, który sprawdza ścieżkę startu bez sejfu domyślnego, woła `ustawSejfDomyslny(null)` i przywraca go po sobie.
import {
  ustawSejfDomyslny,
  utworzSejf,
  bajtyKlucza,
  przypnijSejf,
  sejfBazy,
} from '../../src/core/bezpieczenstwo/sejf-sekretow.js';

/** Stały klucz testów (fikcyjny, tylko do testów). */
export const KLUCZ_TESTOWY = 'dGVzdC1rbHVjei1zZWtyZXRvdy10d29qLW9tcy0zMmI';
export const SEJF_TESTOWY = utworzSejf(bajtyKlucza(KLUCZ_TESTOWY)!);

ustawSejfDomyslny(SEJF_TESTOWY);

export function przywrocSejfDomyslny(): void {
  ustawSejfDomyslny(SEJF_TESTOWY);
}

type Uchwyt = Parameters<typeof sejfBazy>[0];
/** Szyfrogram wartości dla wiersza wstawianego surowym SQL-em w teście (tym kluczem, który uchwyt ma przypięty). */
export function szyfrTestowy(
  db: Uchwyt,
  tabela: string,
  kolumna: string,
  id: string | number,
  jawny: string | null,
): string | null {
  return jawny === null ? null : sejfBazy(db).szyfruj(jawny, { tabela, kolumna, id: String(id) });
}
/** Wszystkie wiersze `konfiguracja_integracji` z ODSZYFROWANYM `sekrety_json` — do asercji „wartości nigdzie nie ma”:
 * `not.toContain` na surowym szyfrogramie przechodzi zawsze i niczego nie sprawdza. */
export function konfiguracjeJawne(db: Uchwyt): Record<string, unknown>[] {
  const wiersze = (db as any).prepare('SELECT * FROM konfiguracja_integracji ORDER BY integracja').all() as Record<
    string,
    any
  >[];
  return wiersze.map((w) => ({
    ...w,
    sekrety_json: String(w.sekrety_json).startsWith('oms1.')
      ? sejfBazy(db).odszyfruj(w.sekrety_json, {
          tabela: 'konfiguracja_integracji',
          kolumna: 'sekrety_json',
          id: String(w.integracja),
        })
      : w.sekrety_json,
  }));
}
/** Tekst jawny z wartości odczytanej surowym SQL-em w teście. */
export function jawnyTestowy(
  db: Uchwyt,
  tabela: string,
  kolumna: string,
  id: string | number,
  zapis: string | null,
): string | null {
  return zapis === null ? null : sejfBazy(db).odszyfruj(zapis, { tabela, kolumna, id: String(id) });
}
export { ustawSejfDomyslny, przypnijSejf, sejfBazy };
