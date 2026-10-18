import { skonfigurowanyUrl } from '../../core/konfiguracja-wartosci.ts';

/** PRZ-069: publiczny adres panelu do linków w mailach (walidacja wpisu; adres z żądania — adresPaneluZZadania). */
export function adresPaneluZEnv(wartosc: string | undefined): string | null {
  const url = skonfigurowanyUrl(wartosc, 'OMS_ADRES_PANELU');
  if (url === undefined) return null;
  const u = new URL(url);
  if (u.pathname !== '/' || u.search || u.hash || u.username || u.password) {
    throw new Error('OMS_ADRES_PANELU: tylko schemat, host i port — bez ścieżki, zapytania i danych logowania');
  }
  return u.origin;
}

/**
 * PRZ-094.04: adres panelu z Ustawień (wiersz „adres_panelu” w konfiguracja_integracji) — ta sama walidacja co
 * OMS_ADRES_PANELU. Zapis, który dziś by nie przeszedł (ręcznie zmieniona baza), = brak adresu, nie wyjątek.
 */
export function adresPaneluZZapisu(zapis: { ustawienia?: Record<string, unknown> } | null): string | null {
  const adres = zapis?.ustawienia?.adres;
  if (typeof adres !== 'string') return null;
  try { return adresPaneluZEnv(adres); } catch { return null; }
}

/**
 * PRZ-094.10: adres bieżącego żądania (`req.protocol` + `req.host`, za zaufanym proxy z X-Forwarded-*) przez tę samą
 * walidację co wpis — tylko schemat, host i port. Nie przechodzi = brak adresu (nie zgadujemy).
 */
export function adresPaneluZZadania(zadanie: { protocol?: string; host?: string } | null): string | null {
  if (!zadanie?.protocol || !zadanie.host) return null;
  try { return adresPaneluZEnv(`${zadanie.protocol}://${zadanie.host}`); } catch { return null; }
}

/**
 * PRZ-094.10: jedyna zasada adresu w linkach z tokenem (/haslo/…), dla maila i „Pokaż link”: OMS_ADRES_PANELU →
 * zapis z Ustawień (oba już w `skonfigurowany`) → adres żądania jako domyślny.
 * ⚠️ Adres z żądania wolno podać tylko z trasy zalogowanego administratora: na ścieżce bez logowania napastnik
 * podstawiłby własny nagłówek Host i link z tokenem, wysłany ofierze, prowadziłby do niego.
 */
export function adresLinkow(skonfigurowany: string | null, zadanie: { protocol?: string; host?: string } | null): { adres: string; domyslny: boolean } | null {
  if (skonfigurowany) return { adres: skonfigurowany, domyslny: false };
  const zZadania = adresPaneluZZadania(zadanie);
  return zZadania ? { adres: zZadania, domyslny: true } : null;
}

/**
 * Formularz adresu panelu: { adres } po normalizacji (origin) albo czytelny błąd bez echa wpisanej wartości.
 * PRZ-094.10: puste pole to nie błąd — { adres: null, blad: null } = usuń zapis, wraca adres domyślny.
 */
export function sprawdzFormularzAdresuPanelu(body: Record<string, unknown> = {}): { adres: string | null; blad: string | null } {
  const wpisany = String(body.adres ?? '');
  if (!wpisany.trim()) return { adres: null, blad: null };
  try {
    const adres = adresPaneluZEnv(wpisany);
    if (adres) return { adres, blad: null };
  } catch { /* komunikat niżej — bez powtarzania wpisanej wartości */ }
  return { adres: null, blad: 'Adres panelu to http:// albo https://, nazwa hosta i ewentualnie port — bez ścieżki, zapytania, spacji i loginu, np. https://panel.twoja-firma.pl.' };
}
