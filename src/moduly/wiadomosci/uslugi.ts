import type { DatabaseSync } from 'node:sqlite';
import { createMailer } from '../../core/poczta/smtp.js';
import { createPotwierdzenie } from './services/potwierdzenie.js';
import { createWiadomosci } from './services/wiadomosci.js';
import { createPollerWiadomosci } from './services/poller-wiadomosci.js';
import { createCzuwaczFormulki } from './services/czuwacz-formulki.js';
import { createOdswiezanieSpraw } from './services/dyskusje.js';

type Fabryka = (opcje: any) => any;
export type FabrykiWiadomosci = Partial<Record<
  'createMailer' | 'createPotwierdzenie' | 'createWiadomosci' | 'createPollerWiadomosci'
  | 'createCzuwaczFormulki' | 'createOdswiezanieSpraw', Fabryka>>;

/** Jeden synchroniczny składacz produkcyjny dla manifestu i adaptera historycznego. */
export function utworzUslugiWiadomosci({ db, config, klienciKanalow, fabryki = {},
  tokenyKanalow = {}, brakiKanalu, proforma = null, infakt = null, teraz = () => new Date(),
}: { db: DatabaseSync; config: any; klienciKanalow: Record<string, any>;
  fabryki?: FabrykiWiadomosci; tokenyKanalow?: Record<string, any>;
  brakiKanalu?: (kanal: string) => string[]; proforma?: any; infakt?: any; teraz?: () => Date }) {
  const braki = brakiKanalu ?? ((kanal: string) =>
    tokenyKanalow[kanal]?.stanDlaEkranu().brakujaceUprawnienia ?? []);
  const odswiezanieSpraw = (fabryki.createOdswiezanieSpraw ?? createOdswiezanieSpraw)({
    db, klienci: klienciKanalow, brakiKanalu: braki, teraz,
  });
  const pollerWiadomosci = (fabryki.createPollerWiadomosci ?? createPollerWiadomosci)({
    db, klienci: klienciKanalow, sprawy: odswiezanieSpraw, brakiKanalu: braki, teraz,
  });
  const czuwaczFormulki = (fabryki.createCzuwaczFormulki ?? createCzuwaczFormulki)({
    db, klienci: klienciKanalow, brakiKanalu: braki, teraz,
  });
  const mailer = config.poczta ? (fabryki.createMailer ?? createMailer)(config.poczta) : null;
  const czasMaila = () => teraz().toISOString();
  const potwierdzenie = mailer ? (fabryki.createPotwierdzenie ?? createPotwierdzenie)({
    db, mailer, sprzedawca: config.sprzedawca ?? {}, oprawaPoczty: config.oprawaPoczty, teraz: czasMaila,
  }) : null;
  const wiadomosci = mailer ? (fabryki.createWiadomosci ?? createWiadomosci)({
    db, mailer, potwierdzenie, proforma, infakt, config, teraz: czasMaila,
  }) : null;
  return { config, klienciWiadomosci: klienciKanalow, mailer, potwierdzenie, wiadomosci,
    pollerWiadomosci, czuwaczFormulki, odswiezanieSpraw };
}

export type UslugiWiadomosci = ReturnType<typeof utworzUslugiWiadomosci> & { gus?: any };
