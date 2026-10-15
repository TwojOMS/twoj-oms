import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { createImportSklepu } from '../../src/moduly/kanaly/services/import-sklep.js';
import { konfiguracjaHistorii } from '../../src/moduly/kanaly/historia.ts';
import { zapiszHistorie, sufitZApilo } from '../../src/oms/db/historia-sprzedazy.js';
describe('historia z jawną konfiguracją firmy', () => {
  it('nie wybiera konta innego sklepu i nie ma firmowego domyślnego konta', () => {
    const db=openOmsDb();
    for(const [konto,dzien] of [[9,'2020-01-01'],[17,'2024-01-01']] as const) zapiszHistorie(db,{apiloId:String(konto),platformAccountId:konto,dzien,utworzoneAt:`${dzien}T12:00:00Z`,brutto:'10',waluta:'PLN',tagi:[],pozycje:[]});
    expect(sufitZApilo(db,17)).toBe('2024-01-01');
    expect(()=>sufitZApilo(db,undefined)).toThrow(/jawne konto/);
    expect(()=>konfiguracjaHistorii({},'sklep','SKLEP')).toThrow(/HISTORIA_KONTO/);db.close();
  });
  it('reguły prywatności i WDT bierze z env, nie z listy firmy w produkcji', () => {
    const k=konfiguracjaHistorii({ SKLEP_HISTORIA_KONTO_APILO:'17',OMS_HISTORIA_MAILE_WDT:'firma@wdt.invalid',OMS_HISTORIA_MAILE_TESTOWE:'robot@test.invalid' },'sklep','SKLEP');
    expect(k.konta.get('sklep')).toBe(17);expect(k.klienciWdt.has('firma@wdt.invalid')).toBe(true);
    expect(k.czyTestowe('robot@test.invalid','')).toBe(true);expect(k.czyTestowe('klient@prawdziwy.invalid','')).toBe(false);
  });
});
