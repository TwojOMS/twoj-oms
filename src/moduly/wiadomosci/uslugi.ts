import type { DatabaseSync } from 'node:sqlite';
import { createMailer } from '../../core/poczta/smtp.js';
import { wczytajKonfiguracjeIntegracji } from '../../oms/db/konfiguracja-integracji.js';
import { pocztaZUstawien } from './poczta-ustawien.ts';
import { createPotwierdzenie } from './services/potwierdzenie.js';
import { createWiadomosci } from './services/wiadomosci.js';
import { createPollerWiadomosci } from './services/poller-wiadomosci.js';
import { createCzuwaczFormulki } from './services/czuwacz-formulki.js';
import { createOdswiezanieSpraw } from './services/dyskusje.js';
import { podpisZPliku, podpisZPanelu } from './podpis-maili.js';

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
  // PRZ-094.04: poczta z pliku (SMTP_*) albo — gdy pliku nie ma — z Ustawień (wiersz „poczta”, pocztaZUstawien czyta
  // zapis przy każdej wysyłce). Plik wygrywa w całości: z SMTP_* pośrednik ustawień w ogóle nie powstaje. Piaskownica
  // podaje `poczta` atrapy (deploy/proba/atrapy/poczta.mjs), więc i tu wszystko idzie przez atrapę.
  const fabrykaMailera: Fabryka = fabryki.createMailer ?? createMailer;
  const pocztaUstawien = config.poczta ? null : pocztaZUstawien({
    wczytaj: () => wczytajKonfiguracjeIntegracji(db, 'poczta'), fabryka: fabrykaMailera });
  // Wiadomości do klientów (potwierdzenie, karta zamówienia) składamy przy starcie — tylko gdy poczta już jest.
  const mailer = config.poczta ? fabrykaMailera(config.poczta) : pocztaUstawien?.gotowy() ? pocztaUstawien : null;
  const pocztaWychodzaca = { zEnv: Boolean(config.poczta) && !config.atrapaPoczty, atrapa: Boolean(config.atrapaPoczty),
    wiadomosciKlientow: Boolean(mailer), ustawien: pocztaUstawien };
  const czasMaila = () => teraz().toISOString();
  // PRZ-102.10: marka i stopka z Ustawień → Poczta, czytane przy każdym mailu; pole ustawione w pliku wygrywa.
  const zPliku = podpisZPliku(config.oprawaPoczty);
  const podpisPanelu = () => podpisZPanelu(db, zPliku);
  const potwierdzenie = mailer ? (fabryki.createPotwierdzenie ?? createPotwierdzenie)({
    db, mailer, sprzedawca: config.sprzedawca ?? {}, oprawaPoczty: config.oprawaPoczty, podpisPanelu, teraz: czasMaila,
  }) : null;
  const wiadomosci = mailer ? (fabryki.createWiadomosci ?? createWiadomosci)({
    db, mailer, potwierdzenie, proforma, infakt, config, podpisPanelu, teraz: czasMaila,
  }) : null;
  return { config, klienciWiadomosci: klienciKanalow, mailer, pocztaWychodzaca, potwierdzenie, wiadomosci,
    pollerWiadomosci, czuwaczFormulki, odswiezanieSpraw };
}

export type UslugiWiadomosci = ReturnType<typeof utworzUslugiWiadomosci> & { gus?: any };
