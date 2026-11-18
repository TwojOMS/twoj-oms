// Ustawienia → Automatyzacje. Strażnik po prefiksie `/ustawienia` wpuszcza tylko konto z uprawnieniem
// „ustawienia”; ekran i zapis dodatkowo tylko dla admina (gość demo publicznego ogląda — wzór ustawienia/trasy/konta.js).
// Model ekranu i zapis automatu KSeF są w module faktur (faktury/trasy/automat-ksef-ekran.js) — jedno źródło dla tego
// adresu i dla starego adresu zapisu na ekranie inFaktu.
// Sekcja reguł (model listy z trasy/reguly.js) i trasy kreatora, dziennika, włącz / wyłącz.
import {
  EKRAN_AUTOMATYZACJI,
  ZAPIS_AUTOMATU_KSEF,
  tylkoAdmin,
  widokEkranuAutomatyzacji,
  obsluzZapisAutomatuKsef,
  zglosDodatkiEkranuAutomatyzacji,
} from '../../faktury/trasy/automat-ksef-ekran.js';
import { modelListyRegul, registerRegulyAutomatyzacji } from './reguly.js';

/** @param {any} app @param {{ db: any, teraz: () => Date, konfiguracjaProgramu: any, automatKsef?: any, reguly?: any, infakt?: any }} opcje */
export function registerEkranAutomatyzacji(
  app,
  { db, teraz, konfiguracjaProgramu, automatKsef = null, reguly = null, infakt = null },
) {
  app.get(
    '/ustawienia/automatyzacje/systemowe',
    async (req, reply) => tylkoAdmin(req, reply) ?? widokEkranuAutomatyzacji(req, reply, zaleznosci),
  );
  const dodatki = reguly ? () => ({ reguly: modelListyRegul({ db, teraz, ...reguly }) }) : undefined;
  // Ten sam model dla odpowiedzi 400 starego adresu zapisu automatu KSeF (ekran inFaktu, moduł faktur).
  if (dodatki) zglosDodatkiEkranuAutomatyzacji(db, dodatki);
  // `infakt` (usługa modułu faktur: klient albo program) — nazwa programu w sekcji automatu KSeF.
  // `konfiguracjaProgramu` — stan wybranego programu (inFakt albo Fakturownia), nie zawsze inFaktu.
  const zaleznosci = { db, teraz, konfiguracjaProgramu, automatKsef, dodatki, infakt };
  app.get(
    EKRAN_AUTOMATYZACJI,
    async (req, reply) => tylkoAdmin(req, reply) ?? widokEkranuAutomatyzacji(req, reply, zaleznosci),
  );
  app.post(ZAPIS_AUTOMATU_KSEF, obsluzZapisAutomatuKsef(zaleznosci));
  if (reguly) registerRegulyAutomatyzacji(app, { db, teraz, ...reguly });
}
