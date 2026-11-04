import { expect, it } from 'vitest';
import { MODULY_KURIEROW } from '../../src/domena/moduly-kurierow.ts';
import { OPISY_PRZEWOZNIKOW } from '../../src/domena/przewoznicy.ts';

it('link śledzenia DPD z rejestru jest taki sam jak na plakietce', () => {
  const numer = '0000000000119U';
  expect(MODULY_KURIEROW.dpd.sledzenieAdres(numer))
    .toBe(OPISY_PRZEWOZNIKOW.dpd.sledzenie.replace('{numer}', numer));
});
