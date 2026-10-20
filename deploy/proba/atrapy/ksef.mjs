// PRZ-102.22 — atrapa klienta KSeF (faktury kosztowe) dla piaskownicy i demo publicznego. Token KSeF zapisany
// w Ustawienia → Integracje → KSeF buduje w trybie próby TĘ atrapę zamiast prawdziwego klienta: „Sprawdź połączenie”
// i nocny czuwacz kosztów chodzą, ale nic nie wychodzi do KSeF.
// Logowanie przyjmuje każdy token poza „zle” (odmowa jak KSeF przy nieważnym tokenie). Lista faktur zakupowych jest
// pusta — koszty demo leżą w bazie z generatora (scripts/demo-dane.mjs), atrapa ich nie dubluje. PDF kosztu z KSeF
// odmawia czytelnie: w demo nie ma oryginalnych dokumentów XML.
import { wymagajTrybuProby } from './tryb.mjs';

const odmowa = (tekst, status = 400) => Object.assign(new Error(tekst), { dlaOperatora: true, status });

export function createAtrapaKsef({ env = process.env, token = null } = {}) {
  wymagajTrybuProby(env, 'atrapa KSeF');
  const za15min = () => new Date(Date.now() + 15 * 60000).toISOString();
  return {
    async zaloguj() {
      if (token === 'zle') throw odmowa('Piaskownica: atrapa KSeF odrzuciła token (token „zle”) — nic nie poszło do KSeF.');
      return { accessToken: 'ATRAPA-ACCESS', accessDo: za15min(), refreshToken: 'ATRAPA-REFRESH', refreshDo: new Date(Date.now() + 7 * 86400000).toISOString() };
    },
    async odswiez() { return { accessToken: 'ATRAPA-ACCESS', accessDo: za15min() }; },
    async pobierzMetadane() { return { faktury: [], hasMore: false, isTruncated: false, koniecNiepewny: false }; },
    async pobierzXml() {
      throw odmowa('Piaskownica: oryginałów faktur z KSeF tu nie ma — w Twoim OMS-ie ten przycisk pobiera dokument z KSeF.');
    },
    atrapa: true,
  };
}
