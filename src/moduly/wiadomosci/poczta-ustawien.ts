// PRZ-094.04 — poczta wychodząca (SMTP) z Ustawień (Ustawienia → Integracje → Poczta wychodząca, wiersz „poczta”
// w konfiguracja_integracji). Wzór: infaktZUstawien (faktury/infakt-ustawien.ts) i kurierzy z Ustawień (PRZ-092).
//
// ⚠️ .env WYGRYWA w całości: gdy plik ma sekcję SMTP_*, ten pośrednik w ogóle nie powstaje (uslugi.ts) — instalacja
// skonfigurowana plikiem działa dokładnie jak przed zmianą.
// ⚠️ `sekrety.haslo` to poświadczenie: nie do logu, komunikatu, odpowiedzi HTTP ani na ekran. Ekran dostaje tylko
// `stanDlaEkranu` (czy hasło jest zapisane), a błąd wysyłki — wyłącznie kod nodemailera (createMailer go tak zawęża).
//
// Pośrednik o kontrakcie createMailer: KAŻDA wysyłka czyta bieżący zapis z bazy; nowy transport powstaje tylko, gdy
// zmieniły się dane — więc zmiana serwera albo hasła działa od następnej wysyłki, bez restartu procesu.
import { konfiguracjaWiadomosci, type PocztaWiadomosci } from './konfiguracja.ts';
import { bladOperatora, komunikatDlaOperatora } from '../../domena/bledy.js';

export const EKRAN_POCZTY = '/ustawienia/integracje/poczta';
export const PORT_DOMYSLNY = 465;

type Zapis = { ustawienia: Record<string, unknown>; sekrety: Record<string, unknown> } | null;
type Mailer = { sendMail: (list: Record<string, unknown>) => Promise<unknown> };

const tekst = (v: unknown) => String(v ?? '').trim();
const HOST = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

/**
 * Konfiguracja nodemailera z zapisu ekranu — przez TĘ SAMĄ funkcję co .env (konfiguracjaWiadomosci), więc port,
 * nadawca i wymagane pola mają jedną walidację. Zapis niepełny albo zepsuty = null (poczta nieustawiona).
 */
export function pocztaZZapisu(zapis: Zapis): PocztaWiadomosci | null {
  if (!zapis) return null;
  const u = zapis.ustawienia ?? {};
  const haslo = String(zapis.sekrety?.haslo ?? '');
  if (!tekst(u.host) || !tekst(u.user) || !haslo.trim()) return null;
  try {
    return konfiguracjaWiadomosci({ SMTP_HOST: tekst(u.host), SMTP_PORT: String(u.port ?? PORT_DOMYSLNY),
      SMTP_USER: tekst(u.user), SMTP_PASS: haslo, ...(tekst(u.nadawca) ? { MAIL_FROM: tekst(u.nadawca) } : {}) }).poczta;
  } catch { return null; }
}

/**
 * Formularz serwera poczty. Puste hasło przy istniejącym zapisie = „zostaw zapisane” — pole hasła nigdy nie wraca
 * na ekran, więc bez tej reguły każda poprawka portu kasowałaby hasło. Komunikaty nie powtarzają wpisanych wartości.
 */
export function sprawdzFormularzPoczty(body: Record<string, unknown> = {}, zapisane: Zapis = null) {
  const bledy: string[] = [];
  const host = tekst(body.host);
  const portTekst = tekst(body.port);
  const user = tekst(body.user);
  const nadawca = tekst(body.nadawca);
  const haslo = String(body.haslo ?? '');
  const port = portTekst === '' ? PORT_DOMYSLNY : Number(portTekst);

  if (!host) bledy.push('Podaj adres serwera poczty wychodzącej (SMTP), np. smtp.twoja-firma.pl.');
  else if (!HOST.test(host)) bledy.push('Adres serwera to sama nazwa hosta, np. smtp.twoja-firma.pl — bez „smtp://”, spacji i ukośników.');
  if (!/^\d{1,5}$/.test(portTekst || String(PORT_DOMYSLNY)) || !Number.isInteger(port) || port < 1 || port > 65535) {
    bledy.push('Port to liczba od 1 do 65535 — zwykle 465 (SSL) albo 587 (STARTTLS).');
  }
  if (!user) bledy.push('Podaj login do skrzynki — zwykle pełny adres e-mail.');
  else if (user.length > 254 || /\s/.test(user)) bledy.push('Login nie może zawierać spacji (najwyżej 254 znaki).');
  const stareHaslo = String(zapisane?.sekrety?.haslo ?? '');
  if (!haslo.trim() && !stareHaslo.trim()) bledy.push('Podaj hasło do skrzynki.');
  else if (haslo.length > 200) bledy.push('Hasło może mieć najwyżej 200 znaków.');
  if (nadawca.length > 200) bledy.push('Nadawca może mieć najwyżej 200 znaków.');

  const ustawienia = { host, port: Number.isInteger(port) ? port : portTekst, user, nadawca };
  const sekrety = { haslo: haslo.trim() ? haslo : stareHaslo };
  // Ostatnia bramka: ta sama funkcja co dla .env (adres nadawcy, domyślnie login, musi być adresem e-mail).
  if (!bledy.length && !pocztaZZapisu({ ustawienia, sekrety })) {
    bledy.push(nadawca
      ? 'Nadawca musi zawierać poprawny adres e-mail, np. sklep@twoja-firma.pl albo „Twoja Firma <sklep@twoja-firma.pl>”.'
      : 'Login nie jest adresem e-mail — wpisz w polu „Nadawca” adres, z którego mają wychodzić maile.');
  }
  return { ustawienia, sekrety, bledy };
}

/** Pośrednik o kontrakcie createMailer, czytający zapis przy każdej wysyłce. `gotowy()` — czy zapis jest kompletny. */
export function pocztaZUstawien({ wczytaj, fabryka }: { wczytaj: () => Zapis; fabryka: (p: PocztaWiadomosci) => Mailer }) {
  let klucz: string | null = null;
  let mailer: Mailer | null = null;
  const biezacy = (): Mailer => {
    const poczta = pocztaZZapisu(wczytaj());
    if (!poczta) {
      throw bladOperatora(`Poczta wychodząca nie jest ustawiona — wpisz serwer SMTP w Ustawienia → Integracje → Poczta wychodząca (${EKRAN_POCZTY}). Nic nie zostało wysłane.`, { status: 400 });
    }
    const nowy = JSON.stringify(poczta);
    if (nowy !== klucz || !mailer) { mailer = fabryka(poczta); klucz = nowy; }
    return mailer;
  };
  return {
    zUstawien: true as const,
    gotowy: () => Boolean(pocztaZZapisu(wczytaj())),
    sendMail: async (list: Record<string, unknown>) => biezacy().sendMail(list),
  };
}

export type PocztaUstawien = ReturnType<typeof pocztaZUstawien>;

/** Trwały log transportu: tylko oczyszczony kod i zdanie ze słownika, nigdy odpowiedź serwera z loginem. */
export function opisBleduPocztyDoLogu(e: { code?: unknown; message?: string }): string | undefined {
  if (!e.code) return e.message;
  const kod = String(e.code).replace(/[^A-Z0-9_]/gu, '').slice(0, 20);
  return `SMTP error (${kod}) — ${komunikatBleduPoczty({ code: kod })}`;
}

/** Polski komunikat błędu wysyłki — z kodu nodemailera, nigdy z treści błędu (bywa w niej odpowiedź serwera z loginem). */
export function komunikatBleduPoczty(e: { code?: unknown; dlaOperatora?: boolean; message?: string } | null | undefined): string {
  if (e?.dlaOperatora && e.message) return e.message;
  const kod = String(e?.code ?? '');
  if (kod === 'EAUTH') return 'Serwer poczty odrzucił login albo hasło. Sprawdź je w ustawieniach skrzynki u dostawcy poczty.';
  if (['ESOCKET', 'ECONNECTION', 'ETIMEDOUT', 'EDNS', 'ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'EPROTOCOL'].includes(kod)) {
    return 'Nie udało się połączyć z serwerem poczty. Sprawdź adres serwera i port (465 dla SSL, 587 dla STARTTLS).';
  }
  if (kod === 'ETLS') return 'Połączenie szyfrowane z serwerem poczty nie powiodło się — sprawdź port (465 albo 587).';
  if (kod === 'EENVELOPE') return 'Serwer poczty odrzucił adres nadawcy albo odbiorcy.';
  return `Serwer poczty nie przyjął wiadomości${kod ? ` (kod ${kod.replace(/[^A-Z0-9_]/gu, '').slice(0, 20)})` : ''}.`;
}

/**
 * PRZ-109.03: znacznik „ten błąd dał transport poczty”. Stawia go WYŁĄCZNIE `catch` wokół `sendMail` (usługi wiadomości
 * i potwierdzenia) i tylko przy kodzie nodemailera — ENOENT ze złożenia treści albo TypeError bez kodu znacznika nie
 * dostają i zostają „błędem technicznym panelu”. Rozróżnienie po miejscu złapania i kodzie, nigdy po treści błędu.
 */
export function oznaczBladPoczty<T>(e: T): T {
  const b = e as unknown as { code?: unknown; zTransportuPoczty?: boolean } | null;
  if (b && typeof b === 'object' && typeof b.code === 'string' && b.code) b.zTransportuPoczty = true;
  return e;
}

/**
 * Zdanie dla operatora po nieudanej wysyłce: błąd transportu → `komunikatBleduPoczty` (+ gdzie poprawić, gdy ekran
 * Ustawień jest dla tego konta otwarty), wszystko inne → `komunikatDlaOperatora`. Treść błędu nie wychodzi na ekran.
 */
export function komunikatWysylkiMaila(e: { code?: unknown; dlaOperatora?: boolean; message?: string; zTransportuPoczty?: boolean } | null | undefined,
  { wskazUstawienia = false }: { wskazUstawienia?: boolean } = {}): string {
  if (!e?.zTransportuPoczty) return komunikatDlaOperatora(e);
  return komunikatBleduPoczty(e) + (wskazUstawienia ? ' Dane serwera poczty poprawisz w Ustawienia → Integracje → Poczta wychodząca.' : '');
}
