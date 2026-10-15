import { it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';

it('domyślny logger rzeczywistej kompozycji zachowuje powód awarii zegara frozen', async () => {
  const dir=mkdtempSync(join(tmpdir(),'prz030-log-'));
  const env={OMS_TRYB:'produkcja',OMS_USER:'operator',OMS_PASS:'atrapa',OMS_DB_PATH:':memory:',
    OMS_SPRZEDAWCA_NIP:'1234563218',OMS_RACHUNEK:'34109010140000000000000000',
    OMS_PROFORMY_KATALOG:dir,OMS_ETYKIETY_KATALOG:dir,OMS_KANALY:'[]',INFAKT_API_KEY:'atrapa'};
  const wynik=await zbudujOms({env});
  const log=vi.spyOn(console,'error').mockImplementation(()=>{});
  try {
    const czuwacz=wynik.usluga<any>('zdrowie','czuwaczOstrzezen');
    vi.spyOn(czuwacz,'przebieg').mockRejectedValue(Error('bezpieczny błąd fixture'));
    await wynik.zegary.find(z=>z.nazwa==='czuwaczOstrzezen')!.przebieg();
    expect(log).toHaveBeenCalledWith('czuwacz ostrzeżeń:','bezpieczny błąd fixture');
  }finally{log.mockRestore();await wynik.app.close();wynik.db.close();}
});
