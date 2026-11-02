// PRZ-122.ZGODA-TFc: jedyne miejsce, w którym wspólny kod sięga po pliki TwojeFaktury (plik WSPÓLNY).
// Kopia bez modułu TwojeFaktury nie ma `szew-twojefaktury.ts` → `null` (moduł „wkrótce”, bez tabel `tf_*`).
// Za „brak szwu” uchodzi WYŁĄCZNIE brak tego jednego pliku. Każdy inny błąd ładowania — także brak pliku, który szew
// importuje (częściowe wycięcie) — przerywa start, a nie udaje „wkrótce” (decyzja kierownika ZGODA-TFc).
// Specyfikator zmienny (URL z `import.meta.url`), więc `tsc` w drzewie bez szwu nie szuka pliku.
import { fileURLToPath } from 'node:url';
import type { SzewTwojeFaktury } from './szew-kontrakt.ts';

export const ADRES_SZWU = new URL('./szew-twojefaktury.ts', import.meta.url);

/** Brakujący moduł z komunikatu Node (`Cannot find module '<ścieżka albo URL>' imported from …`). */
function brakujacyModul(e: any): string | null {
  if (e?.code !== 'ERR_MODULE_NOT_FOUND') return null;
  return /Cannot find module '([^']+)'/u.exec(String(e.message))?.[1] ?? null;
}

export async function wczytajSzew(adres: URL = ADRES_SZWU): Promise<SzewTwojeFaktury | null> {
  try {
    const m = await import(/* @vite-ignore */ adres.href);
    return m.szewTwojeFaktury as SzewTwojeFaktury;
  } catch (e) {
    const brak = brakujacyModul(e);
    if (brak && (brak === adres.href || brak === fileURLToPath(adres))) return null;
    throw e;
  }
}

export const szewTwojeFaktury: SzewTwojeFaktury | null = await wczytajSzew();
