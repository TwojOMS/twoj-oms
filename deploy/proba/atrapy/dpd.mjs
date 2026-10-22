// PRZ-092 — atrapa klienta DPD dla piaskownicy (i demo, które startuje z tych samych atrap). Formularz
// Ustawienia → Integracje → Kurier DPD da się tu wypełnić i „Sprawdzić połączenie”, ale nic nie idzie do DPD:
//   • sprawdzPolaczenie — sukces; hasło zawierające „zle” udaje odrzucone logowanie (żeby obejrzeć komunikat);
//   • nadaj — odmowa 400 jak pozostałe nadania w piaskownicy (usługa nadania zwalnia wtedy rezerwację);
//   • statusPrzesylki — PRZ-108.09: realistyczny przebieg NADANEJ paczki z bazy piaskownicy (zarejestrowana → odebrana przez
//     kuriera 10 min po nadaniu → oddział → wydana do doręczenia → doręczona), liczony od `utworzona_at`; paczki, której
//     nie ma w bazie (albo nie jest nadana), atrapa nie zna — `null`, jak dotąd. Opisy to zdania DPD zmierzone sondą na
//     żywym API zdarzeń (23.08), z fikstury tests/oms/fixtures/dpd/info-events-ok.xml i z białej listy odbioru
//     (domena/przejecie-przesylki.js); „Powiadomienie mail” jak na produkcji — klient pomija je przy wyborze najnowszego.
// Kontrakt z prawdziwym createDpdClient: tests/instalacja/atrapy-kontrakt.test.js (także: prawdziwy klient czyta surową
// odpowiedź SOAP z `surowaOdpowiedzDpd` i oddaje to samo, co atrapa).
import { wymagajTrybuProby } from './tryb.mjs';
import { utworzeniePaczki, zdarzeniaDo } from './przebieg-przesylki.mjs';

export const ODMOWY_DPD = Object.freeze(['nadaj']);

/** [minut po nadaniu, opis zdarzenia DPD]. */
const PRZEBIEG_DPD = Object.freeze([
  [0, 'Zarejestrowano dane przesyłki, przesyłka jeszcze nie nadana'],
  [10, 'Przesyłka odebrana przez Kuriera'],
  [240, 'Przyjęcie przesyłki w oddziale DPD'],
  [1200, 'Przesyłka wydana do doręczenia'],
  [1201, 'Powiadomienie mail'],
  [1560, 'Przesyłka doręczona'],
]);

// eventTime DPD: czas warszawski BEZ strefy ('2026-07-29T20:07:14.918') — tak oddaje go usługa zdarzeń.
const czasDpd = (ms) => `${new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/Warsaw' }).replace(' ', 'T')}.000`;

/** Zdarzenia paczki utworzonej `utworzonaAt`, które nastąpiły do `terazMs` — w kolejności dokumentu DPD. */
export function zdarzeniaAtrapyDpd(utworzonaAt, terazMs) {
  return zdarzeniaDo(PRZEBIEG_DPD, Date.parse(utworzonaAt), terazMs).map((z) => ({ opis: z.stan, at: czasDpd(z.ms) }));
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Surowa odpowiedź getEventsForWaybillV1 (kształt fikstury z żywego DPD) — do testu kontraktu z prawdziwym klientem. */
export function surowaOdpowiedzDpd(zdarzenia, numer = '') {
  const lista = zdarzenia.map((z) => `<eventsList><businessCode>030103</businessCode><country></country><depot></depot>`
    + `<depotName></depotName><description>${esc(z.opis)}</description><eventTime>${esc(z.at)}</eventTime>`
    + `<objectId>0</objectId><packageReference></packageReference><parcelReference></parcelReference><waybill>${esc(numer)}</waybill></eventsList>`).join('');
  return "<?xml version='1.0' encoding='UTF-8'?><S:Envelope xmlns:S=\"http://schemas.xmlsoap.org/soap/envelope/\"><S:Body>"
    + '<ns2:getEventsForWaybillV1Response xmlns:ns2="http://events.dpdinfoservices.dpd.com.pl/"><return><confirmId>0</confirmId>'
    + `${lista}</return></ns2:getEventsForWaybillV1Response></S:Body></S:Envelope>`;
}

export function createAtrapaDpd({ env = process.env, log = () => {}, baza = () => null, teraz = () => new Date() } = {}) {
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
    // Ten sam wybór co createDpdClient.statusPrzesylki: najnowsze po eventTime, z pominięciem powiadomień; historia = całość.
    async statusPrzesylki(numerListu) {
      const utworzona = utworzeniePaczki(baza, { numer: numerListu, kurier: 'dpd' });
      if (utworzona === null) return null;
      const lista = zdarzeniaAtrapyDpd(new Date(utworzona).toISOString(), teraz().getTime());
      if (!lista.length) return null;
      const fizyczne = lista.filter((z) => !/^powiadomienie (mail|sms)/i.test(String(z.opis ?? '').trim()));
      const kandydaci = fizyczne.length ? fizyczne : lista;
      let najnowsze = kandydaci[0];
      for (const z of kandydaci) if (z.at > najnowsze.at) najnowsze = z;
      return { ...najnowsze, historia: lista };
    },
    atrapa: true,
  });
}
