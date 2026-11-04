import {createWidokReklam} from '../marketing/trasy/integracje.js';
import { KATALOG_INTEGRACJI, filtrujIntegracje } from '../../domena/katalog-integracji.ts';
import { polaczeniaIntegracji, podsumowanie, liczPolaczenia } from './services/polaczenia-integracji.ts';
import { nawigacjaUstawien } from './nawigacja.js';
import { MODULY_KURIEROW } from '../../domena/moduly-kurierow.ts';
// PRZ-136.14 (U13): w piaskownicy kurierzy z atrapą (DPD, InPost), KSeF i GUS działają na atrapach jak inFakt i poczta,
// więc lista pokazuje ich wiersze także bez zapisu — jak inne atrapy.
const ATRAPY_PIASKOWNICY = new Set([...Object.values(MODULY_KURIEROW).filter((o) => o.piaskownica?.atrapa).map((o) => o.idKatalogu), 'ksef', 'gus']);
function wPiaskownicy(integracje, proba) {
  return proba ? integracje.map((p) => !p.skonfigurowana && ATRAPY_PIASKOWNICY.has(p.id) ? { ...p, atrapa: true } : p) : integracje;
}
/** Wspólny ekran kanałów i marketingu zachowuje literalny kontekst frozen. */
export function createWidokIntegracji(opcje) {
  const stare = createWidokReklam(opcje);
  return (req, reply, dane = {}) => {
    if (dane.tylkoReklamy) return stare(req, reply, dane);
    const katalog = req.url.split('?')[0] === '/ustawienia/integracje/katalog';
    const filtry = { szukaj: String(req.query?.szukaj ?? '').slice(0, 100), kategoria: String(req.query?.kategoria ?? ''), planowane: req.query?.planowane !== 'nie' };
    const kanaly = (opcje.stanyKanalow?.() ?? []).map(stan => ({ stan, wiazanie: opcje.wiazanieKanalow?.stan?.(stan.kanal) ?? null }));
    const integracje = wPiaskownicy(opcje.integracje?.() ?? [], opcje.proba === true);
    const polaczenia = polaczeniaIntegracji({ db: opcje.db, kanaly: opcje.kanaly?.() ?? {}, stanyKanalow: kanaly.map(k => k.stan), integracje, proba: opcje.proba === true, polaczeniaAllegro:opcje.polaczeniaAllegro?.()??[], sklepyWoo:opcje.sklepyWoo?.()??[] });
    return reply.view('ustawienia-polaczenia.ejs', { title: katalog ? 'Dodaj integrację' : 'Moje połączenia', nawigacja: nawigacjaUstawien(req, reply),
      katalog, filtry, uslugi: filtrujIntegracje(filtry), wszystkieUslugi: KATALOG_INTEGRACJI, polaczenia, liczPolaczenia, podsumowanie: podsumowanie(polaczenia), kanaly, blad: dane.blad ?? null,
      zapisano: req.query?.zapisano === 'kanal' ? 'Rozpoczęto wiązanie kanału Allegro.' : req.query?.zapisano === 'usunieto_sklep' ? 'Usunięto sklep WooCommerce.' : null });
  };
}
