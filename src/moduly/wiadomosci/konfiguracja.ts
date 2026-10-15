import type { Srodowisko } from '../../core/kontrakty.ts';
import { oprawaMaila } from './oprawa.js';

export type PocztaWiadomosci = {
  smtp: { host: string; port: number; user: string; pass: string };
  mailFrom: string;
};

/** Jawny tryb bez SMTP; rozpoczęta konfiguracja nie może cicho wyłączyć poczty. */
export function konfiguracjaWiadomosci(env: Srodowisko): {
  poczta: PocztaWiadomosci | null;
  oprawaPoczty?: ReturnType<typeof oprawaMaila>;
} {
  const oprawa = env.OMS_MAIL_MARKA !== undefined || env.OMS_MAIL_STOPKA !== undefined
    ? { oprawaPoczty: oprawaMaila({ podpis: env.OMS_MAIL_MARKA,
      naglowek: env.OMS_MAIL_MARKA, footer: env.OMS_MAIL_STOPKA }) }
    : {};
  const klucze = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_PORT', 'MAIL_FROM'];
  if (!klucze.some(k => env[k] !== undefined)) return { poczta: null, ...oprawa };
  const brak = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'].filter(k => !env[k]?.trim());
  if (brak.length) throw new Error(`Brak wymaganej konfiguracji poczty: ${brak.join(', ')}`);
  const port = env.SMTP_PORT === undefined ? 465 : Number(env.SMTP_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SMTP_PORT musi być liczbą całkowitą od 1 do 65535.');
  }
  const mailFrom = env.MAIL_FROM === undefined ? env.SMTP_USER!.trim() : env.MAIL_FROM.trim();
  // Nodemailer przyjmuje także „Nazwa <adres>”. Sprawdzamy adres, bez wypisywania go w błędzie.
  const koperta = /^(?:[^<>\r\n]*<([^<>\r\n]+)>|([^<>\r\n]+))$/.exec(mailFrom);
  const adres = (koperta?.[1] ?? koperta?.[2] ?? '').trim();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(adres)) {
    throw new Error('MAIL_FROM (domyślnie SMTP_USER) musi zawierać poprawny adres nadawcy.');
  }
  return { poczta: { smtp: { host: env.SMTP_HOST!.trim(), port,
    user: env.SMTP_USER!, pass: env.SMTP_PASS! }, mailFrom }, ...oprawa };
}
