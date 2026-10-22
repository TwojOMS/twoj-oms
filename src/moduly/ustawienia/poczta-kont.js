// PRZ-069: maile systemowe do pracownika (nie do klienta firmy). Mailer opcjonalny — bez modułu
// wiadomości albo bez SMTP wysyłki nie ma, „Pokaż link” działa zawsze. Nadawca: MAIL_FROM (createMailer).
import { renderMailHtml } from '../../core/poczta/mail-html.js';
import { zlozTresc, zlozTemat } from '../../domena/szablony-wiadomosci.js';
import { WAZNOSC_LINKU_MS } from './linki-hasla.js';

// {waznosc} w szablonie — z tej samej stałej, która naprawdę unieważnia link (48 h → „48 h").
const WAZNOSC_SLOWNIE = `${WAZNOSC_LINKU_MS / 3_600_000} h`;

export const TEMATY = { zaproszenie: 'Zaproszenie do panelu', reset: 'Ustawienie nowego hasła' };
const BRAK_USLUGI = '„wiadomosci.mailer" nie istnieje';

const BRAK_POCZTY = '„wiadomosci.pocztaWychodzaca" nie istnieje';

/** Stan poczty wychodzącej z modułu wiadomości (PRZ-094.04) albo null — bez modułu albo w starym składzie usług. */
export function pocztaOpcjonalna(usluga) {
  return () => {
    try { return usluga('wiadomosci', 'pocztaWychodzaca') ?? null; }
    catch (e) { if (e instanceof Error && e.message.includes(BRAK_POCZTY)) return null; throw e; }
  };
}

/**
 * Mailer do maili systemowych albo null. `wiadomosci.mailer` to plik .env, atrapa piaskownicy albo (PRZ-108.02:
 * zawsze, gdy pliku nie ma) pośrednik poczty z Ustawień, czytający zapis przy każdej wysyłce — zaproszenie i reset
 * hasła działają od razu po zapisie, bez restartu. Zapasowo `pocztaWychodzaca.ustawien` (stary skład usług).
 * Mailer z Ustawień bez kompletnego zapisu (nieustawiony albo odłączony) = null.
 * Łapie wyłącznie brak usługi (moduł wiadomości niezbudowany).
 */
export function mailerOpcjonalny(usluga) {
  const poczta = pocztaOpcjonalna(usluga);
  return () => {
    let mailer;
    try { mailer = usluga('wiadomosci', 'mailer') ?? null; }
    catch (e) { if (e instanceof Error && e.message.includes(BRAK_USLUGI)) return null; throw e; }
    const kandydat = mailer ?? poczta()?.ustawien ?? null;
    if (kandydat && typeof kandydat.gotowy === 'function' && !kandydat.gotowy()) return null;
    return kandydat;
  };
}

/**
 * Treść maila do pracownika. `szablon` (PRZ-101.06) = zapis z Ustawień → Szablony wiadomości → Maile do zespołu;
 * `null` = dzisiejsza treść niżej, co do znaku (test równości: tests/moduly/ustawienia/szablony-konta.test.js).
 * ⚠️ Link trafia WYŁĄCZNIE do maila — ta funkcja niczego nie loguje, a podgląd w Ustawieniach podaje link zmyślony.
 */
export function trescMaila({ cel, imie, link, szablon = null }) {
  if (szablon) {
    const pola = { imie: String(imie ?? ''), link: String(link ?? ''), waznosc: WAZNOSC_SLOWNIE };
    const text = zlozTresc(szablon.tresc, { pola }).tekst;
    return { subject: zlozTemat(szablon.temat, pola), text, html: renderMailHtml({ text }) };
  }
  const wstep = cel === 'zaproszenie'
    ? 'Administrator zaprosił Cię do pracy w systemie obsługi zamówień.'
    : 'Administrator przygotował link do ustawienia nowego hasła w systemie obsługi zamówień.';
  const text = [`Dzień dobry, ${imie}!`, '', wstep, 'Ustaw hasło pod adresem:', link, '',
    'Link działa 48 h i tylko raz. Jeśli to nie Ty — zignoruj tę wiadomość.'].join('\n');
  return { subject: TEMATY[cel], text, html: renderMailHtml({ text }) };
}

const BRAK_PODPISU = '„wiadomosci.podpisMaili" nie istnieje';

/** Usługa podpisu maili (PRZ-102.10) albo null — bez modułu wiadomości sekcja „Podpis maili” znika z ekranu Poczty. */
export function podpisOpcjonalny(usluga) {
  return () => {
    try { return usluga('wiadomosci', 'podpisMaili') ?? null; }
    catch (e) { if (e instanceof Error && e.message.includes(BRAK_PODPISU)) return null; throw e; }
  };
}
