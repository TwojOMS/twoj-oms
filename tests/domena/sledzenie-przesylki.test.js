import { describe, it, expect } from 'vitest';
import { sledzeniePrzesylki } from '../../src/domena/sledzenie-przesylki.js';

// KOGO PYTAC O STATUS TEJ PACZKI — jedna regula dla karty i dla zegara przesylek.
//
// Sedno: paczka „Wysylam z Allegro" fizycznie jedzie DPD, a w `odpowiedz_surowa` lezy
// `carrierId: DPD` + `carrierWaybill` (numeryczny list DPD). ZMIERZONE 23.08 sonda na zywym
// API zdarzen: nasz kanal DPD_INFO odpowiada takze dla listow kupionych przez Allegro
// (7 zdarzen dla prawdziwego carrierWaybill). Dotad WzA nosilo `bezSledzenia` i 23 paczki
// byly slepe — teraz pytamy PODWYKONAWCE wprost, z pominieciem Allegro.
//
// Pozostale WzA korzystaja z zasobu sledzenia Allegro. Zwrot `null` znaczy, ze brak
// kompletnych danych lub klienta — nie zgadujemy przewoznika ani numeru.

const dpd = { statusPrzesylki: () => {} };
const inpost = { statusPrzesylki: () => {} };
const allegroSledzenie = { statusPrzesylki: () => {} };
const wza = { bezSledzenia: true };
const KURIERZY = { dpd, inpost, allegro_wza: wza };

const surowaWza = JSON.stringify({
  id: 'shp-1',
  carrierTrackingData: { carrierId: 'DPD', carrierWaybill: '1049419215075U' },
});

describe('sledzeniePrzesylki', () => {
  it('wlasni kurierzy pytani wprost, wlasnym numerem listu', () => {
    const w = sledzeniePrzesylki({ kurier: 'dpd', numer_listu: '13445566' }, KURIERZY);
    expect(w).toEqual({ klient: dpd, numer: '13445566', podwykonawca: null });
    const i = sledzeniePrzesylki({ kurier: 'inpost', numer_listu: '6660001112' }, KURIERZY);
    expect(i.klient).toBe(inpost);
  });

  it('WzA z carrierem DPD idzie do naszego klienta DPD numerem podwykonawcy', () => {
    const w = sledzeniePrzesylki(
      { kurier: 'allegro_wza', numer_listu: 'AD0JPWG95J5151BTJ', odpowiedz_surowa: surowaWza },
      KURIERZY,
    );
    expect(w).toEqual({ klient: dpd, numer: '1049419215075U', podwykonawca: 'DPD' });
  });

  it('One Box 1336 pyta Allegro numerem z packages.waybill, nie numerem podwykonawcy', () => {
    const surowa = JSON.stringify({
      id: 'shipment-one', deliveryMethodId: 'metoda-one', carrier: 'ALLEGRO',
      packages: [{
        waybill: 'AD0ONEBOX', type: 'PACKAGE',
        transportingInfo: [{ carrierId: 'ALLEGRO_ONE_KURIER', carrierWaybill: 'SUBCONTRACT' }],
      }],
      labelFormat: 'PDF',
    });
    const wynik = sledzeniePrzesylki(
      { kurier: 'allegro_wza', numer_listu: 'AD0ONEBOX', odpowiedz_surowa: surowa },
      { ...KURIERZY, allegro: allegroSledzenie },
    );
    expect(wynik).toEqual({
      klient: allegroSledzenie, numer: 'AD0ONEBOX', podwykonawca: null,
      kontekst: { carrier: 'ALLEGRO' },
    });
  });

  it.each([
    ['ORLEN', 'ORLEN_PACZKA'],
    ['DHL', 'DHL_PARCEL'],
  ])('%s WzA przekazuje carrier z własnego zasobu, bez stałej ALLEGRO', (_usluga, carrier) => {
    const surowa = JSON.stringify({
      carrier,
      packages: [{ waybill: 'AD0PUNKT', transportingInfo: [{ carrierId: 'INNY', carrierWaybill: 'SUB' }] }],
    });
    const wynik = sledzeniePrzesylki(
      { kurier: 'allegro_wza', numer_listu: 'AD0PUNKT', odpowiedz_surowa: surowa },
      { ...KURIERZY, allegro: allegroSledzenie },
    );
    expect(wynik).toEqual({
      klient: allegroSledzenie, numer: 'AD0PUNKT', podwykonawca: null,
      kontekst: { carrier },
    });
  });

  it('DPD nadal używa własnego kanału, gdy klient Allegro jest też dostępny', () => {
    const surowa = JSON.stringify({
      carrier: 'ALLEGRO',
      packages: [{ waybill: 'AD0DPD', transportingInfo: [{ carrierId: 'DPD', carrierWaybill: '1049000000000U' }] }],
    });
    expect(sledzeniePrzesylki(
      { kurier: 'allegro_wza', numer_listu: 'AD0DPD', odpowiedz_surowa: surowa },
      { ...KURIERZY, allegro: allegroSledzenie },
    )).toEqual({ klient: dpd, numer: '1049000000000U', podwykonawca: 'DPD' });
  });

  it('DPD bez własnego klienta może użyć potwierdzonej pary carrier/waybill Allegro', () => {
    const surowa = JSON.stringify({
      carrier: 'ALLEGRO',
      packages: [{ waybill: 'AD0DPD', transportingInfo: [{ carrierId: 'DPD', carrierWaybill: '1049000000000U' }] }],
    });
    expect(sledzeniePrzesylki(
      { kurier: 'allegro_wza', numer_listu: 'AD0DPD', odpowiedz_surowa: surowa },
      { allegro_wza: wza, allegro: allegroSledzenie },
    )).toEqual({
      klient: allegroSledzenie, numer: 'AD0DPD', podwykonawca: null,
      kontekst: { carrier: 'ALLEGRO' },
    });
  });

  it('Allegro nie jest pytane, gdy brakuje carrier lub numer nie zgadza się z pakietem', () => {
    const paczka = { kurier: 'allegro_wza', numer_listu: 'AD0PRAWIDLOWY' };
    const klienci = { ...KURIERZY, allegro: allegroSledzenie };
    expect(sledzeniePrzesylki({
      ...paczka, odpowiedz_surowa: JSON.stringify({ packages: [{ waybill: 'AD0PRAWIDLOWY' }] }),
    }, klienci)).toBe(null);
    expect(sledzeniePrzesylki({
      ...paczka, odpowiedz_surowa: JSON.stringify({ carrier: 'ALLEGRO', packages: [{ waybill: 'AD0INNY' }] }),
    }, klienci)).toBe(null);
    expect(sledzeniePrzesylki({
      ...paczka, odpowiedz_surowa: JSON.stringify({ carrier: 'ALLEGRO', packages: [{ waybill: 'AD0PRAWIDLOWY' }] }),
    }, KURIERZY)).toBe(null);
  });

  it('WzA bez klienta DPD w mapie, bez carrierWaybill albo z obcym carrierem = null', () => {
    expect(sledzeniePrzesylki(
      { kurier: 'allegro_wza', numer_listu: 'AD0X', odpowiedz_surowa: surowaWza },
      { allegro_wza: wza },
    )).toBe(null);
    expect(sledzeniePrzesylki(
      { kurier: 'allegro_wza', numer_listu: 'AD0X', odpowiedz_surowa: JSON.stringify({ carrierId: 'UPS', carrierWaybill: '1Z999' }) },
      KURIERZY,
    )).toBe(null);
    expect(sledzeniePrzesylki(
      { kurier: 'allegro_wza', numer_listu: 'AD0X', odpowiedz_surowa: JSON.stringify({ id: 'bez-carriera' }) },
      KURIERZY,
    )).toBe(null);
  });

  it('zepsuty JSON surowej odpowiedzi nie wybucha — po prostu null', () => {
    expect(sledzeniePrzesylki(
      { kurier: 'allegro_wza', numer_listu: 'AD0X', odpowiedz_surowa: '{nie-json' },
      KURIERZY,
    )).toBe(null);
  });

  // ⚠️ Regresja programistyczna (klient BEZ metody statusPrzesylki, bez flagi) ma przejsc
  // DALEJ i pasc glosno jako BLAD TECHNICZNY — wnioskowanie z braku metody uciszyloby ja.
  // Ta sama zasada dla podwykonawcy WzA: zepsuty klient DPD krzyczy, nie znika.
  it('regresja u kuriera ze sledzeniem NIE jest uciszana (decyduje flaga, nie obecnosc metody)', () => {
    const zepsuty = {};
    const w = sledzeniePrzesylki({ kurier: 'dpd', numer_listu: '123' }, { dpd: zepsuty });
    expect(w).toEqual({ klient: zepsuty, numer: '123', podwykonawca: null });
    const wza2 = sledzeniePrzesylki(
      { kurier: 'allegro_wza', numer_listu: 'AD0X', odpowiedz_surowa: surowaWza },
      { dpd: zepsuty, allegro_wza: wza },
    );
    expect(wza2.klient).toBe(zepsuty);
  });

  it('kurier bez sledzenia i kurier spoza mapy = null', () => {
    expect(sledzeniePrzesylki({ kurier: 'allegro', numer_listu: 'A005DUH6H5' }, KURIERZY)).toBe(null);
    expect(sledzeniePrzesylki({ kurier: 'dpd', numer_listu: '123' }, {})).toBe(null);
    expect(sledzeniePrzesylki({ kurier: 'dpd', numer_listu: null }, KURIERZY)).toBe(null);
  });

  // Pola carrier* bywaja na roznych glebokosciach zasobu Allegro — szukamy rekurencyjnie,
  // ale TYLKO pary z tego samego obiektu: carrierId z jednego wpisu i waybill z innego
  // moglyby zszyc DPD z numerem InPostu.
  it('carrierId i carrierWaybill musza pochodzic z TEGO SAMEGO obiektu', () => {
    const rozjechane = JSON.stringify({
      a: { carrierId: 'DPD' },
      b: { carrierWaybill: '1049000000000U' },
    });
    expect(sledzeniePrzesylki(
      { kurier: 'allegro_wza', numer_listu: 'AD0X', odpowiedz_surowa: rozjechane },
      KURIERZY,
    )).toBe(null);
  });

  // Luke pokazala mutacja (`&&` → `||` z domyslnym 'DPD'): sam numer bez identyfikatora
  // przewoznika dostawalby ZMYSLONE DPD — i numer nieznanego kuriera pojechalby do naszego
  // kanalu zdarzen. Polowa pary to nie para.
  it('sam carrierWaybill bez carrierId to NIE para — zadnego zgadywania przewoznika', () => {
    expect(sledzeniePrzesylki(
      { kurier: 'allegro_wza', numer_listu: 'AD0X', odpowiedz_surowa: JSON.stringify({ carrierWaybill: '1049000000000U' }) },
      KURIERZY,
    )).toBe(null);
    expect(sledzeniePrzesylki(
      { kurier: 'allegro_wza', numer_listu: 'AD0X', odpowiedz_surowa: JSON.stringify({ carrierId: 'DPD' }) },
      KURIERZY,
    )).toBe(null);
  });
});

// KANAL ALLEGRO (25.08.2026) — paczki nadane POZA panelem: Allegro Punkt, Allegro One,
// oraz ogon `allegro_dpd` sprzed 11.08. Do tego dnia `kurier = 'allegro'` nie mial klienta
// w mapie i kazda taka paczka byla slepa na zawsze.
//
// ⚠️ ROZNICA WOBEC WzA: tam identyfikator przewoznika wydlubujemy z `odpowiedz_surowa`
// przesylki, ktora SAMI utworzylismy. Tutaj przesylki nie tworzylismy — `carrierId`
// przychodzi z `GET /order/checkout-forms/{id}/shipments` i siedzi w kolumnie
// `przesylki.carrier_allegro`.
describe('sledzeniePrzesylki — kanal Allegro', () => {
  const allegro = { statusPrzesylki: () => {} };
  const Z_ALLEGRO = { ...KURIERZY, allegro };

  it('pyta klienta Allegro, przekazujac carrierId jako kontekst', () => {
    const w = sledzeniePrzesylki(
      { kurier: 'allegro', numer_listu: 'A005DUH6H5', carrier_allegro: 'ALLEGRO' },
      Z_ALLEGRO,
    );
    expect(w).toEqual({
      klient: allegro, numer: 'A005DUH6H5', podwykonawca: null, kontekst: { carrier: 'ALLEGRO' },
    });
  });

  // ⚠️ ZMIERZONE 25.08: zly carrierId oddaje HTTP 200 z `trackingDetails: null`, czyli
  // odpowiedz nieodroznialna od paczki swiezo nadanej. Domyslne 'ALLEGRO' dzialaloby na
  // dzisiejszych danych (wszystkie zmierzone paczki maja wlasnie ten identyfikator)
  // i zamilkloby po cichu przy pierwszej z innym. To ta sama rodzina bledu, co „polowa
  // pary" przy WzA wyzej.
  it('brak carrier_allegro to null — bez podstawiania stalej', () => {
    expect(sledzeniePrzesylki({ kurier: 'allegro', numer_listu: 'A005DUH6H5' }, Z_ALLEGRO)).toBe(null);
    expect(sledzeniePrzesylki({ kurier: 'allegro', numer_listu: 'A005DUH6H5', carrier_allegro: '' }, Z_ALLEGRO)).toBe(null);
    expect(sledzeniePrzesylki({ kurier: 'allegro', numer_listu: 'A005DUH6H5', carrier_allegro: null }, Z_ALLEGRO)).toBe(null);
  });

  it('brak numeru listu to null, tak samo jak u pozostalych kurierow', () => {
    expect(sledzeniePrzesylki({ kurier: 'allegro', carrier_allegro: 'ALLEGRO' }, Z_ALLEGRO)).toBe(null);
  });

  // Panel bez skonfigurowanego kanalu Allegro to TRYB POPRAWNY — ta sama zasada, co przy
  // braku sekcji INPOST_*. Wtedy `KURIERZY` nie ma klucza `allegro` i paczka jest po prostu
  // nieodpytywana, zamiast wywalac karte na `undefined.statusPrzesylki`.
  it('brak klienta Allegro w mapie to null, nie awaria', () => {
    expect(sledzeniePrzesylki(
      { kurier: 'allegro', numer_listu: 'A005DUH6H5', carrier_allegro: 'ALLEGRO' },
      KURIERZY,
    )).toBe(null);
  });
});
