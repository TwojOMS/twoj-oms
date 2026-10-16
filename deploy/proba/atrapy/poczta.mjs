// PRZ-087 — atrapa poczty dla piaskownicy i demo publicznego. Bez SMTP_* moduł wiadomości nie składa usługi
// `wiadomosci` (uslugi.ts: mailer = null), więc karta zamówienia nie pokazywała sekcji wiadomości wcale — gość demo
// nie wiedział, że panel pisze do klienta. Decyzja właściciela 16.10: sekcja stoi, „Wyślij” przechodzi całą drogę
// (szablon, podgląd, zapis w historii zamówienia), a list nie wychodzi nigdzie.
//
// ⛔ Atrapa ZASTĘPUJE pocztę także wtedy, gdy ktoś wpisze SMTP_* do env piaskownicy: z piaskownicy i demo żaden
// mail nie ma prawa wyjść (adresy klientów demo i tak są .invalid, ale klient po edycji karty mógłby wpisać prawdziwy).
import { createMailer } from '../../../src/core/poczta/smtp.js';
import { konfiguracjaWiadomosci } from '../../../src/moduly/wiadomosci/konfiguracja.ts';
import { createModulWiadomosci } from '../../../src/moduly/wiadomosci/modul.ts';
import { wymagajTrybuProby } from './tryb.mjs';

export const POCZTA_ATRAPY = Object.freeze({
  smtp: { host: 'atrapa-poczty.invalid', port: 465, user: 'atrapa', pass: 'atrapa' },
  mailFrom: 'Pracownia Półcień (demo) <sklep@example.invalid>',
});

/** Mailer o kontrakcie createMailer, którego transport niczego nie wysyła — tylko notuje w logu kontenera. */
export function createAtrapaPoczty({ env = process.env, log = (...t) => console.log(...t) } = {}) {
  wymagajTrybuProby(env, 'atrapa poczty');
  let licznik = 0;
  const mailer = createMailer({ ...POCZTA_ATRAPY, transportFactory: () => ({
    async sendMail({ to, subject }) {
      licznik += 1;
      log(`atrapa poczty: „${subject}” do ${to} (piaskownica — nic nie poszło)`);
      return { messageId: `<atrapa-${Date.now()}-${licznik}@example.invalid>`, accepted: [].concat(to ?? []), rejected: [] };
    },
  }) });
  return { ...mailer, atrapa: true };
}

/** Moduł wiadomości z atrapą poczty w miejsce SMTP z env. */
export function createModulWiadomosciAtrapy(env) {
  wymagajTrybuProby(env, 'moduł wiadomości piaskownicy');
  const modul = createModulWiadomosci({ fabryki: { createMailer: () => createAtrapaPoczty({ env }) } });
  return { ...modul, konfiguracja: (e) => ({ ...konfiguracjaWiadomosci({ ...e, SMTP_HOST: undefined, SMTP_USER: undefined,
    SMTP_PASS: undefined, SMTP_PORT: undefined, MAIL_FROM: undefined }), poczta: POCZTA_ATRAPY }) };
}
