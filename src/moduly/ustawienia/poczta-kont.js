// PRZ-069: maile systemowe do pracownika (nie do klienta firmy). Mailer opcjonalny — bez modułu
// wiadomości albo bez SMTP wysyłki nie ma, „Pokaż link” działa zawsze. Nadawca: MAIL_FROM (createMailer).
import { renderMailHtml } from '../../core/poczta/mail-html.js';

export const TEMATY = { zaproszenie: 'Zaproszenie do panelu', reset: 'Ustawienie nowego hasła' };
const BRAK_USLUGI = '„wiadomosci.mailer" nie istnieje';

/** Usługa `wiadomosci.mailer` albo null; łapie wyłącznie brak usługi (moduł wiadomości niezbudowany). */
export function mailerOpcjonalny(usluga) {
  return () => {
    try { return usluga('wiadomosci', 'mailer') ?? null; }
    catch (e) { if (e instanceof Error && e.message.includes(BRAK_USLUGI)) return null; throw e; }
  };
}

export function trescMaila({ cel, imie, link }) {
  const wstep = cel === 'zaproszenie'
    ? 'Administrator zaprosił Cię do pracy w panelu zamówień.'
    : 'Administrator przygotował link do ustawienia nowego hasła w panelu zamówień.';
  const text = [`Dzień dobry, ${imie}!`, '', wstep, 'Ustaw hasło pod adresem:', link, '',
    'Link działa 48 h i tylko raz. Jeśli to nie Ty — zignoruj tę wiadomość.'].join('\n');
  return { subject: TEMATY[cel], text, html: renderMailHtml({ text }) };
}
