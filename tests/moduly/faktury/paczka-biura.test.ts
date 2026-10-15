import { describe, it, expect, vi } from 'vitest';
import { paczkaBiuraDlaTras } from '../../../src/moduly/faktury/paczka-biura.ts';

describe('jawna usługa paczki biura PRZ-025', () => {
  it('wiąże rzeczywistą usługę po budowie modułów i przekazuje oba wywołania', async () => {
    let gotowe = false;
    const koszty = { zbuduj: vi.fn().mockResolvedValue({ bajty: Buffer.from('pdf') }),
      zbudujZestawieniePrzychodow: vi.fn().mockResolvedValue({ bajty: Buffer.from('przychody') }) };
    const lookup = vi.fn(() => { if (!gotowe) throw new Error('Brak usługi koszty.paczkaDlaBiura'); return koszty; });
    const paczka = paczkaBiuraDlaTras(lookup);
    expect(lookup).not.toHaveBeenCalled();
    expect(() => paczka.zbuduj('2026-08', 'sprzedaz')).toThrow('koszty.paczkaDlaBiura');
    gotowe = true;
    await paczka.zbuduj('2026-08', 'sprzedaz');
    await paczka.zbudujZestawieniePrzychodow('2026-08');
    expect(koszty.zbuduj).toHaveBeenCalledWith('2026-08', 'sprzedaz');
    expect(koszty.zbudujZestawieniePrzychodow).toHaveBeenCalledWith('2026-08');
  });
});
