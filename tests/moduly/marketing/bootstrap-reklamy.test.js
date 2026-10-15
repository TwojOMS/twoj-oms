import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zbudujOms, uruchomZegary } from '../../pomoc/bootstrap-parytetu.ts';
import { zapiszPolaczenie, dni } from '../../../src/oms/db/reklamy.js';

const env = (nad = {}) => ({
  OMS_AUTH_USER: 'adam', OMS_AUTH_PASS: 'x', OMS_DB_PATH: ':memory:',
  OMS_ETYKIETY_DIR: mkdtempSync(join(tmpdir(), 'oms-reklamy-')),
  ...nad,
});

describe('okablowanie bieżących reklam', () => {
  it('bez połączeń czuwacz istnieje i nie pyta zewnętrznych API', async () => {
    const { czuwaczReklam } = zbudujOms({ env: env() });
    expect(czuwaczReklam).toBeTruthy();
    expect(await czuwaczReklam.przebieg()).toMatchObject({ sukcesy: 0, bledy: 0 });
  });

  it('istniejący klient GA4 trafia do nowego czuwacza po przypięciu własnej właściwości', async () => {
    const raportReklam = vi.fn(async () => ({
      waluta: 'PLN', dni: [{ dzien: '2026-09-22', kampaniaId: '42', nazwa: 'Produktowa',
        koszt: '10.00', klikniecia: 4, wyswietlenia: 100 }], transakcje: [],
    }));
    const { db, czuwaczReklam } = zbudujOms({
      env: env({ GA4_KLUCZ: '/data-oms/klucz.json' }),
      createGa4: () => ({ dzienneStatystyki: vi.fn(), raportReklam }),
    });
    const p = zapiszPolaczenie(db, { typ: 'ga4', kontoId: 'property-firmy', kanal: 'pro',
      waluta: 'PLN', strefa: 'Europe/Warsaw', sekretRef: 'legacy-ga4' });
    await czuwaczReklam.przebieg();
    expect(raportReklam).toHaveBeenCalledOnce();
    expect(dni(db, { typ: 'ga4', polaczenieId: p.id })).toHaveLength(1);
  });

  it('rejestruje niezależny zegar nowych reklam', () => {
    const ustawInterwal = vi.fn(() => 1);
    const czuwaczReklam = { przebieg: vi.fn(async () => ({ sukcesy: 0, bledy: 0 })) };
    uruchomZegary({ czuwaczReklam, ustawInterwal });
    expect(ustawInterwal).toHaveBeenCalled();
  });
});
