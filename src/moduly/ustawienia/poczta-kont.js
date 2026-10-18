// PRZ-069: maile systemowe do pracownika (nie do klienta firmy). Mailer opcjonalny — bez modułu
// wiadomości albo bez SMTP wysyłki nie ma, „Pokaż link” działa zawsze. Nadawca: MAIL_FROM (createMailer).
import { renderMailHtml } from '../../core/poczta/mail-html.js';

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
 * Mailer do maili systemowych albo null. Najpierw `wiadomosci.mailer` (plik .env, atrapa piaskownicy albo poczta
 * z Ustawień zapisana przed startem); bez niego — poczta z Ustawień zapisana już po starcie (PRZ-094.04: zaproszenie
 * i reset hasła działają od razu, bez restartu). Mailer z Ustawień bez kompletnego zapisu (odłączony) = null.
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

export function trescMaila({ cel, imie, link }) {
  const wstep = cel === 'zaproszenie'
    ? 'Administrator zaprosił Cię do pracy w systemie obsługi zamówień.'
    : 'Administrator przygotował link do ustawienia nowego hasła w systemie obsługi zamówień.';
  const text = [`Dzień dobry, ${imie}!`, '', wstep, 'Ustaw hasło pod adresem:', link, '',
    'Link działa 48 h i tylko raz. Jeśli to nie Ty — zignoruj tę wiadomość.'].join('\n');
  return { subject: TEMATY[cel], text, html: renderMailHtml({ text }) };
}
