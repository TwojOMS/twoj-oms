import { szewTwojeFaktury } from '../../../src/moduly/faktury/wczytaj-szew.ts';
// PRZ-122.B07b (scalenie z B05a): moduł faktur podaje trasom Ustawień → Firma prawdziwy wybór programu — sekcja
// „Zwolnienie z VAT” jest tylko przy TwojeFaktury (w próbie), bez opakowania z zwolnienie-vat-prz122.test.js.
// Panel z pomocy testów (nowyPanel), sieć zabroniona. Dane zmyślone („Pracownia Półcień”).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { nowyPanel, jako, get } from '../../pomoc/konta-prz068.js';

beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw Error('Sieć zabroniona'); }); });
afterEach(() => { vi.restoreAllMocks(); });

async function sekcjaZwolnienia(env) {
  const p = nowyPanel({ env });
  zalozKonto(p.db, { login: 'polcien', imie: 'Pracownia Półcień', haslo: 'h', rola: 'administrator', admin: true });
  const r = await get(p.app, '/ustawienia/faktury/vat', jako(p.db, 'polcien'));
  expect(r.statusCode).toBe(200);
  return r.body.includes('id="zwolnienie-vat"');
}

describe('PRZ-122.B07b — sekcja „Zwolnienie z VAT” z prawdziwego wyboru programu', () => {
  it.runIf(szewTwojeFaktury)('próba + TwojeFaktury → sekcja jest', async () => {
    expect(await sekcjaZwolnienia({ OMS_TRYB: 'proba', OMS_PROGRAM_FAKTUROWY: 'twojefaktury', OMS_TWOJEFAKTURY: 'tak' })).toBe(true);
  });
  it('produkcja bez programu → sekcji nie ma', async () => {
    expect(await sekcjaZwolnienia({ OMS_TRYB: 'produkcja' })).toBe(false);
  });
});
