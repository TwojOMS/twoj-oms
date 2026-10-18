// PRZ-093.09 — atrapa klienta InPost (ShipX) dla piaskownicy (i demo, które startuje z tych samych atrap). Wzór:
// dpd.mjs. Formularz Ustawienia → Integracje → Kurier InPost da się tu wypełnić i „Sprawdzić połączenie”, ale nic
// nie idzie do InPostu:
//   • sprawdzPolaczenie — sukces; token zawierający „zle” udaje odrzucony token (żeby obejrzeć komunikat);
//   • nadaj, sprawdzPrzesylke, pobierzEtykiete — odmowa 400 jak pozostałe nadania w piaskownicy (usługa nadania
//     zwalnia wtedy rezerwację); atrapa nie ma przesyłek, więc nie ma czego sprawdzać ani drukować;
//   • statusPrzesylki — brak zdarzeń.
// Kontrakt z prawdziwym createInpostClient: tests/instalacja/atrapy-kontrakt.test.js.
import { wymagajTrybuProby } from './tryb.mjs';

export const ODMOWY_INPOST = Object.freeze(['nadaj', 'sprawdzPrzesylke', 'pobierzEtykiete']);

const odmowa = async () => {
  throw Object.assign(new Error('Piaskownica: atrapa InPost nie nadaje paczek — nic nie poszło do InPostu.'), { dlaOperatora: true, status: 400 });
};

export function createAtrapaInpost({ env = process.env, log = () => {} } = {}) {
  wymagajTrybuProby(env, 'atrapa InPost');
  return (opcje) => ({
    async sprawdzPolaczenie() {
      log('atrapa InPost: sprawdzenie połączenia (piaskownica — nic nie poszło do InPostu)');
      if (String(opcje?.token ?? '').includes('zle')) {
        throw Object.assign(new Error('InPost odrzucił żądanie (HTTP 401): Token is missing or invalid (atrapa piaskownicy)'), { dlaOperatora: true });
      }
      return { ok: true };
    },
    nadaj: odmowa,
    sprawdzPrzesylke: odmowa,
    pobierzEtykiete: odmowa,
    async statusPrzesylki() { return null; },
    atrapa: true,
  });
}
