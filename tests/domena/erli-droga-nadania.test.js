import { expect, it } from 'vitest';
import { drogaNadaniaErli } from '../../src/domena/erli-droga-nadania.js';

const metodyErli = [{ id: 'erliPaczkomat', name: 'Paczkomat ERLI' }];
const metodyDostawy = [
  { id: 'erliWlasna', name: 'Własna DPD', vendor: 'dpd' },
  { id: 'inpost', name: 'InPost', vendor: 'inpost' },
  { id: 'odbior', name: 'Odbiór', vendor: 'selfPickup' },
  { id: 'dhl', name: 'Kurier testowy', vendor: 'dhl' },
];
it.each([
  ['erliPaczkomat', null, { droga: 'przesylki_erli', metoda: metodyErli[0] }],
  ['erliWlasna', null, { droga: 'umowa', kurier: 'dpd', metoda: metodyDostawy[0] }],
  ['inpost', { externalId: 'PC001' }, { droga: 'umowa', kurier: 'inpost_paczkomat', metoda: metodyDostawy[1] }],
  ['inpost', null, { droga: 'umowa', kurier: 'inpost_kurier', metoda: metodyDostawy[1] }],
  ['odbior', null, { droga: 'umowa', kurier: 'odbior', metoda: metodyDostawy[2] }],
])('%s (punkt: %j) rozpoznaje wyłącznie ze słowników', (typeId, pickupPlace, wynik) => {
  expect(drogaNadaniaErli({ typeId, pickupPlace, metodyErli, metodyDostawy })).toEqual(wynik);
});
it.each([['nieznana', 'Nowa dostawa'], ['dhl', 'Kurier testowy'], ['erliNieznana', 'Nowa dostawa']])('%s blokuje bez zgadywania', (typeId, nazwa) => {
  expect(drogaNadaniaErli({ typeId, nazwa, metodyErli, metodyDostawy })).toEqual({ droga: 'blokada',
    komunikat: `ERLI: nie wiem, jak nadać metodę ${nazwa} (${typeId}) — sprawdź cennik dostaw w panelu ERLI albo mapowanie w Ustawieniach` });
});
// PRZ-157.11b: mapowanie z kroku 3 konfiguratora rozstrzyga kuriera metody umowy firmy; metod ERLI nie zmienia.
it.each([
  ['erliWlasna', null, { erliWlasna: 'inpost_paczkomat' }, { droga: 'umowa', kurier: 'inpost_paczkomat', metoda: metodyDostawy[0] }],
  ['dhl', null, { dhl: 'dpd' }, { droga: 'umowa', kurier: 'dpd', metoda: metodyDostawy[3] }],
  ['inpost', null, { inpost: 'odbior' }, { droga: 'umowa', kurier: 'odbior', metoda: metodyDostawy[1] }],
  ['erliPaczkomat', null, { erliPaczkomat: 'dpd' }, { droga: 'przesylki_erli', metoda: metodyErli[0] }],
  ['inpost', { externalId: 'PC001' }, { erliWlasna: 'brak' }, { droga: 'umowa', kurier: 'inpost_paczkomat', metoda: metodyDostawy[1] }],
])('%s z mapą %j bierze kuriera z mapy', (typeId, pickupPlace, mapa, wynik) => {
  expect(drogaNadaniaErli({ typeId, pickupPlace, metodyErli, metodyDostawy, mapa })).toEqual(wynik);
});
it.each([['erliWlasna', 'brak'], ['erliWlasna', 'nieznany'], ['erliWlasna', '__proto__']])('%s z mapą %s blokuje z komunikatem o mapowaniu', (typeId, kurier) => {
  const w = drogaNadaniaErli({ typeId, metodyErli, metodyDostawy, mapa: { [typeId]: kurier } });
  expect(w.droga).toBe('blokada');
  expect(w.komunikat).toBe('ERLI: metoda Własna DPD (erliWlasna) nie ma kuriera — wybierz kuriera w Ustawieniach → ERLI → Metody dostawy albo nadaj w ERLI');
});
