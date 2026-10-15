import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Socket } from 'node:net';
import dns from 'node:dns/promises';
import { tmpdir } from 'node:os';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { pobranieDoWysylki } from '../../../src/domena/allegro-wysylka.js';

// Powrót do fallbacku env.DPD_NADAWCA_NAZWA bez czynnego kuriera ma
// zepsuć odmowę konsumenta konfiguracji, nie tylko odcisk samego źródła.
// Żadna obecna METODY_WZA nie ma wymagaKonta:true. Ten jawny wariant
// chroni zachowany kontrakt reguły dla usługi wymagającej rachunku;
// nie udaje dziś osiągalnego zakupu przez adapter WzA.
const podstawowe = {
  OMS_TRYB: 'produkcja', OMS_USER: 'operator', OMS_PASS: 'fixture',
  OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000',
  OMS_PROFORMY_KATALOG: tmpdir(), OMS_ETYKIETY_KATALOG: tmpdir(),
  DPD_NADAWCA_NAZWA: 'Nadawca testowy',
};
const adres = { DPD_NADAWCA_ULICA: 'Testowa 1', DPD_NADAWCA_KOD: '00-001', DPD_NADAWCA_MIASTO: 'Testowo' };
let polaczenia: string[];
beforeEach(() => {
  polaczenia = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { polaczenia.push('fetch'); throw Error('Sieć zabroniona'); });
  vi.spyOn(Socket.prototype, 'connect').mockImplementation(() => { polaczenia.push('socket'); throw Error('Sieć zabroniona'); });
  vi.spyOn(dns, 'lookup').mockImplementation(async () => { polaczenia.push('dns'); throw Error('DNS zabroniony'); });
});
afterEach(() => { vi.restoreAllMocks(); expect(polaczenia).toEqual([]); });

it.each([
  { wariant: 'sama nazwa bez kuriera', env: {}, wolno: false },
  { wariant: 'pełny adres bez kuriera', env: adres, wolno: false },
  { wariant: 'czynny DPD ze zwalidowanym nadawcą', env: {
    ...adres, DPD_URL: 'https://fixture.invalid/dpd', DPD_LOGIN: 'fixture',
    DPD_PASSWORD: 'fixture', DPD_FID: '1', DPD_INFO_URL: 'https://fixture.invalid/info', DPD_INFO_CHANNEL: '1',
  }, wolno: true },
])('$wariant: konfiguracja pełnego OMS zachowuje właściciela wymaganego pobrania', async ({ env, wolno }) => {
  const a = await zbudujOms({ env: { ...podstawowe, ...env } });
  try {
    const config = a.usluga<any>('wysylka', 'config');
    const input = {
      pobranieUslugi: true, cashOnDelivery: { amount: '83.99', currency: 'PLN' }, limit: '6000',
      ownerName: config.pobranieNadawca.nazwa, iban: config.pobranieNadawca.rachunek,
      nadpisanieOperatora: null,
    };
    const wymagane = pobranieDoWysylki({ ...input, wymaganeKonto: true });
    if (wolno) expect(wymagane).toEqual({ wolno: true, cashOnDelivery: {
      amount: '83.99', currency: 'PLN', ownerName: 'Nadawca testowy', iban: 'PL34109010140000000000000000',
    } });
    else expect(wymagane).toEqual({ wolno: false, powod: 'Ta usługa wymaga konta do zwrotu pobrania, a panel go nie ma.' });
    // Obecna usługa WALLET_TRANSFER nie potrzebuje właściciela ani naszego IBAN.
    expect(pobranieDoWysylki({ ...input, wymaganeKonto: false })).toEqual({ wolno: true,
      cashOnDelivery: { amount: '83.99', currency: 'PLN' } });
  } finally { await a.app.close(); a.db.close(); }
});
