import fs from 'node:fs';

// PRZ-099: ekran Ustawienia → Aktualizacje — tylko informacja (plan docs/plany/PRZ-095-099-aktualizacje.md, zadanie 5).
// Bieżąca wersja z /app/wydanie.json (ma go wyłącznie obraz zbudowany z paczki klienta), najnowsza z GitHub Releases
// na kliknięcie administratora — nigdy w tle, żeby instalacja nie łączyła się z GitHubem bez wiedzy klienta.
// Adres repo jest stałą, nie zmienną env: fork i tak zmienia kod, a zmienna kosztowałaby wpis w manifeście konfiguracji.
export const REPO_AKTUALIZACJI = 'TwojOMS/twoj-oms';
const WZOR_WERSJI = /^v(\d+)\.(\d+)\.(\d+)$/;
const MAKS_OPISU = 4000;

export type Wydanie = { commit: string; wersja: string | null; utworzono: string | null };
export type WynikSprawdzenia =
  | { stan: 'jest'; wersja: string; opublikowano: string; opis: string; adres: string }
  | { stan: 'brak-wydan' }
  | { stan: 'limit' }
  | { stan: 'blad' };
type Http = (adres: string, init?: RequestInit) => Promise<Response>;

/** Wydanie z wydanie.json paczki; poza obrazem z paczki (repo, produkcja z runnera) — null. */
export function odczytajWydanie(plik: URL): Wydanie | null {
  try {
    const w = JSON.parse(fs.readFileSync(plik, 'utf8'));
    if (typeof w?.commit !== 'string' || !/^[0-9a-f]{40}$/.test(w.commit)) return null;
    return {
      commit: w.commit,
      wersja: typeof w.wersja === 'string' && WZOR_WERSJI.test(w.wersja) ? w.wersja : null,
      utworzono: typeof w.utworzono === 'string' ? w.utworzono : null,
    };
  } catch { return null; }
}

/** Porównanie liczbowe vX.Y.Z — napisowe uznałoby v0.9.0 za nowsze od v0.10.0. */
export function porownajWersje(a: string, b: string): -1 | 0 | 1 {
  const pa = (WZOR_WERSJI.exec(a) ?? []).slice(1).map(Number);
  const pb = (WZOR_WERSJI.exec(b) ?? []).slice(1).map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0) ? 1 : -1;
  }
  return 0;
}

/** Najnowsze opublikowane wydanie (GitHub pomija szkice i wydania wstępne w releases/latest). */
export async function sprawdzNajnowsze({ http }: { http: Http }): Promise<WynikSprawdzenia> {
  try {
    const r = await http(`https://api.github.com/repos/${REPO_AKTUALIZACJI}/releases/latest`, {
      headers: { 'User-Agent': 'TwojOMS-aktualizacje', Accept: 'application/vnd.github+json' },
    });
    if (r.status === 404) return { stan: 'brak-wydan' };
    // Bez tokenu GitHub daje 60 zapytań na godzinę z jednego adresu; przekroczenie to 403 albo 429.
    if (r.status === 403 || r.status === 429) return { stan: 'limit' };
    if (r.status !== 200) return { stan: 'blad' };
    const w = await r.json();
    if (typeof w?.tag_name !== 'string' || !WZOR_WERSJI.test(w.tag_name)) return { stan: 'blad' };
    return {
      stan: 'jest',
      wersja: w.tag_name,
      opublikowano: typeof w.published_at === 'string' ? w.published_at : '',
      opis: typeof w.body === 'string' ? w.body.slice(0, MAKS_OPISU) : '',
      adres: typeof w.html_url === 'string' ? w.html_url : `https://github.com/${REPO_AKTUALIZACJI}/releases`,
    };
  } catch { return { stan: 'blad' }; }
}
