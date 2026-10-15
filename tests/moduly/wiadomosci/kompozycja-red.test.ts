import { describe, it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';

// PRZ-029 RED: obecna rzeczywista kompozycja bootstrapu (domyślna lista modułów, realna DB SQLite).
const env = { OMS_USER: 'operator', OMS_PASS: 'fixture',
  OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000',
  OMS_PROFORMY_KATALOG: tmpdir(), OMS_ETYKIETY_KATALOG: tmpdir() };
const headers = { authorization: `Basic ${Buffer.from('operator:fixture').toString('base64')}` };

describe('PRZ-029 rzeczywista kompozycja wiadomości', () => {
  it('bootstrap obsługuje ekrany wiadomości, klientów i ustawień formułki', async () => {
    const transport = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Sieć zabroniona'));
    let z: Awaited<ReturnType<typeof zbudujOms>> | undefined;
    try {
      z = await zbudujOms({ env });
      const statusy: Record<string, number> = {};
      for (const url of ['/wiadomosci', '/klienci', '/ustawienia/wiadomosci-i-automatyzacje'])
        statusy[url] = (await z.app.inject({ method: 'GET', url, headers })).statusCode;
      expect(statusy).toEqual({ '/wiadomosci': 200, '/klienci': 200, '/ustawienia/wiadomosci-i-automatyzacje': 200 });
      expect(transport).not.toHaveBeenCalled();
    } finally {
      try { if (z) await z.app.close(); } finally { z?.db.close(); transport.mockRestore(); }
    }
  });

  it('kolekcja usług ma poller, czuwacz formułki i odświeżanie spraw na wspólnej mapie klientów kanałów', async () => {
    const transport = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Sieć zabroniona'));
    let z: Awaited<ReturnType<typeof zbudujOms>> | undefined;
    try {
      z = await zbudujOms({ env });
      const a = z;
      const jest = (nazwa: string) => { try { a.usluga('wiadomosci', nazwa); return true; } catch { return false; } };
      expect(Object.fromEntries(['klienciWiadomosci', 'pollerWiadomosci', 'czuwaczFormulki', 'odswiezanieSpraw'].map(n => [n, jest(n)])))
        .toEqual({ klienciWiadomosci: true, pollerWiadomosci: true, czuwaczFormulki: true, odswiezanieSpraw: true });
      expect(a.usluga('wiadomosci', 'klienciWiadomosci')).toBe(a.usluga('kanaly', 'klienciKanalow'));
      expect(transport).not.toHaveBeenCalled();
    } finally {
      try { if (z) await z.app.close(); } finally { z?.db.close(); transport.mockRestore(); }
    }
  });

  it('kolekcja zegarów ma otoczki pollera wiadomości (300000 ms) i czuwacza formułki (120000 ms)', async () => {
    const transport = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Sieć zabroniona'));
    let z: Awaited<ReturnType<typeof zbudujOms>> | undefined;
    try {
      z = await zbudujOms({ env });
      const zegary = Object.fromEntries(z.zegary.map(x => [x.nazwa, x.odstepMs]));
      expect({ pollerWiadomosci: zegary.pollerWiadomosci, czuwaczFormulki: zegary.czuwaczFormulki })
        .toEqual({ pollerWiadomosci: 300000, czuwaczFormulki: 120000 });
      expect(transport).not.toHaveBeenCalled();
    } finally {
      try { if (z) await z.app.close(); } finally { z?.db.close(); transport.mockRestore(); }
    }
  });
});
