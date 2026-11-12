import { expect, it } from 'vitest';
import { zgloszeniaZwrotowErli } from '../../src/domena/erli-zwroty.js';

it('zgłoszenia: indeksy od zera, ilość, polski powód, komentarz i data; bez danych konta', () => {
  const returns = [{ items: [{ index: 1, quantity: 2 }], reason: 'itemsDescription',
    comment: 'Inny wzór', created: '2026-11-11T10:00:00Z', bankAccount: { number: '00000000000000000000000000' } }];
  expect(zgloszeniaZwrotowErli(returns, [{ name: 'Pierwszy' }, { name: 'Drugi' }])).toEqual([
    { data: '2026-11-11T10:00:00Z', powod: 'Niezgodny z opisem', komentarz: 'Inny wzór', pozycje: [{ nazwa: 'Drugi', ilosc: 2 }] },
  ]);
  expect(returns[0]).toHaveProperty('bankAccount'); // funkcja prezentacji jest czysta
});

it.each([
  ['resign', 'Kupujący zrezygnował z zakupu'], ['mistake', 'Kupujący dokonał zakupu przez pomyłkę'],
  ['itemsQuality', 'Przedmiot wadliwy lub uszkodzony'], ['itemsDescription', 'Niezgodny z opisem'],
  ['deliveryQuality', 'Towar uszkodzony podczas transportu'], ['other', 'Inny powód'],
  ['doesNotFit', 'Nie pasuje kupującemu'], ['itemIsMissing', 'Brakuje elementu'],
  ['notDeliveredOnTime', 'Niedostarczony na czas'], ['itemDamaged', 'Przedmiot uszkodzony (paczka nieuszkodzona)'],
  ['itemAndPackageDamaged', 'Przedmiot i paczka uszkodzone'],
])('powód %s → %s', (reason, powod) => {
  expect(zgloszeniaZwrotowErli([{ reason, items: [] }], [])[0].powod).toBe(powod);
});

it('nieznany powód zostaje, nieznany indeks ma opis; brak zgłoszeń daje pustą listę', () => {
  expect(zgloszeniaZwrotowErli([{ reason: 'nowyPowod', items: [{ index: 9, quantity: 3 }] }], []))
    .toEqual([{ data: null, powod: 'nowyPowod', komentarz: null, pozycje: [{ nazwa: 'pozycja nr 9', ilosc: 3 }] }]);
  expect(zgloszeniaZwrotowErli(undefined, [])).toEqual([]);
});
