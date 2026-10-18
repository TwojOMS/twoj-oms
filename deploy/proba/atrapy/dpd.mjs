// PRZ-092 — atrapa klienta DPD dla piaskownicy (i demo, które startuje z tych samych atrap). Formularz
// Ustawienia → Integracje → Kurier DPD da się tu wypełnić i „Sprawdzić połączenie”, ale nic nie idzie do DPD:
//   • sprawdzPolaczenie — sukces; hasło zawierające „zle” udaje odrzucone logowanie (żeby obejrzeć komunikat);
//   • nadaj — odmowa 400 jak pozostałe nadania w piaskownicy (usługa nadania zwalnia wtedy rezerwację);
//   • statusPrzesylki — brak zdarzeń.
// Kontrakt z prawdziwym createDpdClient: tests/instalacja/atrapy-kontrakt.test.js.
import { wymagajTrybuProby } from './tryb.mjs';

export const ODMOWY_DPD = Object.freeze(['nadaj']);

export function createAtrapaDpd({ env = process.env, log = () => {} } = {}) {
  wymagajTrybuProby(env, 'atrapa DPD');
  return (opcje) => ({
    async sprawdzPolaczenie() {
      log('atrapa DPD: sprawdzenie połączenia (piaskownica — nic nie poszło do DPD)');
      if (String(opcje?.haslo ?? '').includes('zle')) {
        throw Object.assign(new Error('DPD odrzuciło żądanie: Login failed for login: *** (atrapa piaskownicy)'), { dlaOperatora: true });
      }
      return { ok: true };
    },
    async nadaj() {
      throw Object.assign(new Error('Piaskownica: atrapa DPD nie nadaje paczek — nic nie poszło do DPD.'), { dlaOperatora: true, status: 400 });
    },
    async statusPrzesylki() { return null; },
    atrapa: true,
  });
}
