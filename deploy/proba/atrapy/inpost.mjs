// PRZ-093.09 — atrapa klienta InPost (ShipX) dla piaskownicy (i demo, które startuje z tych samych atrap). Wzór:
// dpd.mjs. Formularz Ustawienia → Integracje → Kurier InPost da się tu wypełnić i „Sprawdzić połączenie”, ale nic
// nie idzie do InPostu:
//   • sprawdzPolaczenie — sukces; token zawierający „zle” udaje odrzucony token (żeby obejrzeć komunikat);
//   • nadaj, sprawdzPrzesylke, pobierzEtykiete — odmowa 400 jak pozostałe nadania w piaskownicy (usługa nadania
//     zwalnia wtedy rezerwację); atrapa nie ma przesyłek, więc nie ma czego sprawdzać ani drukować;
//   • statusPrzesylki — PRZ-108.09: realistyczny przebieg NADANEJ paczki z bazy piaskownicy (zarejestrowana → przyjęta
//     w oddziale nadawczym 10 min po nadaniu → wysłana z oddziału → gotowa do odbioru → odebrana przez klienta), liczony
//     od `utworzona_at`; paczki spoza bazy — `null`. Stany wyłącznie z OPISY_STANOW klienta (zmierzone na koncie).
// Kontrakt z prawdziwym createInpostClient: tests/instalacja/atrapy-kontrakt.test.js (także: prawdziwy klient czyta surową
// odpowiedź ShipX z `surowaOdpowiedzInpost` i oddaje to samo, co atrapa).
import { wymagajTrybuProby } from './tryb.mjs';
import { utworzeniePaczki, zdarzeniaDo } from './przebieg-przesylki.mjs';
import { OPISY_STANOW } from '../../../src/oms/kurierzy/inpost.js';

export const ODMOWY_INPOST = Object.freeze(['nadaj', 'sprawdzPrzesylke', 'pobierzEtykiete']);

/** [minut po nadaniu, stan ShipX]. */
const PRZEBIEG_INPOST = Object.freeze([
  [0, 'confirmed'],
  [10, 'adopted_at_source_branch'],
  [180, 'sent_from_source_branch'],
  [1200, 'ready_to_pickup'],
  [1560, 'delivered'],
]);

/** Wpisy `tracking_details` ShipX paczki utworzonej `utworzonaAt`, które nastąpiły do `terazMs` (najnowszy pierwszy). */
export function zdarzeniaAtrapyInpost(utworzonaAt, terazMs) {
  return zdarzeniaDo(PRZEBIEG_INPOST, Date.parse(utworzonaAt), terazMs)
    .map((z) => ({ status: z.stan, origin_status: z.stan, agency: null, datetime: new Date(z.ms).toISOString() })).reverse();
}

/** Surowa odpowiedź `GET /v1/tracking/{numer}` — do testu kontraktu z prawdziwym klientem. */
export function surowaOdpowiedzInpost(numer, szczegoly) {
  return { tracking_number: String(numer), service: 'inpost_locker_standard', type: 'inpost_locker_standard',
    status: szczegoly[0]?.status ?? 'created', custom_attributes: {}, tracking_details: szczegoly,
    expected_flow: [], created_at: szczegoly[szczegoly.length - 1]?.datetime ?? null, updated_at: szczegoly[0]?.datetime ?? null };
}

const odmowa = async () => {
  throw Object.assign(new Error('Piaskownica: atrapa InPost nie nadaje paczek — nic nie poszło do InPostu.'), { dlaOperatora: true, status: 400 });
};

export function createAtrapaInpost({ env = process.env, log = () => {}, baza = () => null, teraz = () => new Date() } = {}) {
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
    // Ten sam wynik co createInpostClient.statusPrzesylki: `{ opis, at }` NAJNOWSZEGO zdarzenia (po wartości czasu).
    async statusPrzesylki(numerListu) {
      const utworzona = utworzeniePaczki(baza, { numer: numerListu, kurier: 'inpost' });
      if (utworzona === null) return null;
      const szczegoly = zdarzeniaAtrapyInpost(new Date(utworzona).toISOString(), teraz().getTime());
      if (!szczegoly.length) return null;
      let najnowsze = szczegoly[0];
      for (const z of szczegoly) if (Date.parse(z.datetime) > Date.parse(najnowsze.datetime)) najnowsze = z;
      return { opis: OPISY_STANOW[najnowsze.status] ?? `InPost: nieznany stan „${najnowsze.status}”`, at: najnowsze.datetime };
    },
    atrapa: true,
  });
}
