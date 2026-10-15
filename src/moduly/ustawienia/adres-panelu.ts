import { skonfigurowanyUrl } from '../../core/konfiguracja-wartosci.ts';

/** PRZ-069: publiczny adres panelu do linków w mailach. Nigdy z nagłówków żądania. */
export function adresPaneluZEnv(wartosc: string | undefined): string | null {
  const url = skonfigurowanyUrl(wartosc, 'OMS_ADRES_PANELU');
  if (url === undefined) return null;
  const u = new URL(url);
  if (u.pathname !== '/' || u.search || u.hash || u.username || u.password) {
    throw new Error('OMS_ADRES_PANELU: tylko schemat, host i port — bez ścieżki, zapytania i danych logowania');
  }
  return u.origin;
}
