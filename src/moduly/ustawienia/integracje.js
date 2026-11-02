import {createWidokReklam} from '../marketing/trasy/integracje.js';
import { KATALOG_INTEGRACJI, filtrujIntegracje } from '../../domena/katalog-integracji.ts';
import { polaczeniaIntegracji } from './services/polaczenia-integracji.ts';
import { nawigacjaUstawien } from './nawigacja.js';
/** Wspólny ekran kanałów i marketingu zachowuje literalny kontekst frozen. */
export function createWidokIntegracji(opcje) {
  const stare = createWidokReklam(opcje);
  return (req, reply, dane = {}) => {
    if (dane.tylkoReklamy) return stare(req, reply, dane);
    const katalog = req.url.split('?')[0] === '/ustawienia/integracje/katalog';
    const filtry = { szukaj: String(req.query?.szukaj ?? '').slice(0, 100), kategoria: String(req.query?.kategoria ?? ''), planowane: req.query?.planowane !== 'nie' };
    const kanaly = (opcje.stanyKanalow?.() ?? []).map(stan => ({ stan, wiazanie: opcje.wiazanieKanalow?.stan?.(stan.kanal) ?? null }));
    const polaczenia = polaczeniaIntegracji({ db: opcje.db, kanaly: opcje.kanaly?.() ?? {}, stanyKanalow: kanaly.map(k => k.stan), integracje: opcje.integracje?.() ?? [], proba: opcje.proba === true });
    return reply.view('ustawienia-polaczenia.ejs', { title: katalog ? 'Dodaj integrację' : 'Moje połączenia', nawigacja: nawigacjaUstawien(req, reply),
      katalog, filtry, uslugi: filtrujIntegracje(filtry), wszystkieUslugi: KATALOG_INTEGRACJI, polaczenia, kanaly, blad: dane.blad ?? null,
      zapisano: req.query?.zapisano === 'kanal' ? 'Rozpoczęto wiązanie kanału Allegro.' : null });
  };
}
