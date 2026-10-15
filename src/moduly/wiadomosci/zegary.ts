import type { Zegar } from '../../core/kontrakty.ts';

export const ODSTEP_POLLERA_WIADOMOSCI_MS = 300000;
export const ODSTEP_CZUWACZA_FORMULKI_MS = 120000;
type Przebieg = { przebieg: () => Promise<any> };
type Log = (...tekst: string[]) => void;
const komunikat = (e: unknown) => e instanceof Error ? e.message : String(e);

/** Odczyt metody dopiero przy tyknięciu: manifest i adapter wołają tę samą instancję. */
export function zegarPolleraWiadomosci({ pollerWiadomosci, log }: {
  pollerWiadomosci: Przebieg; log: Log;
}): Zegar {
  return { nazwa: 'pollerWiadomosci', odstepMs: ODSTEP_POLLERA_WIADOMOSCI_MS,
    przebieg: async () => {
      try { await pollerWiadomosci.przebieg(); }
      catch (e) { log('poller wiadomości:', komunikat(e)); }
    } };
}

export function zegarCzuwaczaFormulki({ czuwaczFormulki, log }: {
  czuwaczFormulki: Przebieg; log: Log;
}): Zegar {
  return { nazwa: 'czuwaczFormulki', odstepMs: ODSTEP_CZUWACZA_FORMULKI_MS,
    przebieg: async () => {
      try {
        const wynik = await czuwaczFormulki.przebieg();
        // Wstrzymany autoresponder wygląda jak cisza u kupujących, więc musi zostawić ślad.
        // Normalnego przebiegu nie logujemy: frozen oznaczałby 720 wpisów na dobę.
        if (wynik?.wstrzymany) {
          log('autoresponder WSTRZYMANY: próg formułek na godzinę przekroczony.');
        }
      } catch (e) { log('autoresponder:', komunikat(e)); }
    } };
}
