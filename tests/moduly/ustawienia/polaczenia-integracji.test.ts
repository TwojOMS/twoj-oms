import { it, expect } from 'vitest';
import { nowyPanel } from '../../pomoc/konta-prz068.js';
import * as service from '../../../src/moduly/ustawienia/services/polaczenia-integracji.ts';

const odczyt = (o: any) => (service as any).polaczeniaIntegracji?.(o);
it('pusta instalacja nie dostaje pozornych połączeń', async () => {
  const { app, db } = nowyPanel();
  try { expect(odczyt({ db })).toEqual([]); } finally { await app.close(); db.close(); }
});
it('dwa konta Allegro i dwa Woo zachowują osobne stany, WzA ma źródło konto_allegro', async () => {
  const { app, db } = nowyPanel();
  try {
    db.prepare('INSERT INTO stan_pollera(sklep,ostatni_przebieg_at,ostatni_blad) VALUES(?,?,?)').run('a1','2026-10-31T10:00:00Z',null);
    db.prepare('INSERT INTO stan_pollera(sklep,ostatni_przebieg_at,ostatni_blad) VALUES(?,?,?)').run('a2','2026-10-31T10:01:00Z','Nie wypisuj surowego błędu z kluczem SEKRET');
    const m = odczyt({ db, kanaly: { kanaly: { a1: { clientSecret: 'SEKRET' }, a2: {} }, sklepy: { w1: {}, w2: {} } }, stanyKanalow: [{kanal:'a1',kontoAllegro:'konto A'},{kanal:'a2',kontoAllegro:'konto B'}] });
    expect(m.filter((p: any)=>p.usluga==='allegro')).toHaveLength(2);
    expect(m.filter((p: any)=>p.usluga==='woocommerce')).toHaveLength(2);
    expect(m.find((p: any)=>p.id==='allegro:a1')).toMatchObject({stan:'dziala',ostatniSukcesAt:'2026-10-31T10:00:00Z'});
    expect(m.find((p: any)=>p.id==='allegro:a2')).toMatchObject({stan:'uwaga',ostatniSukcesAt:null});
    expect(m.filter((p: any)=>p.usluga==='wza').every((p: any)=>p.zrodlo==='konto_allegro' && p.stan==='niesprawdzone')).toBe(true);
    expect(JSON.stringify(m)).not.toContain('SEKRET');
    expect(new Set(m.map((p: any)=>p.id)).size).toBe(m.length);
  } finally { await app.close(); db.close(); }
});
it('obecność konfiguracji nie dowodzi udanego odczytu; źródło serwer niezależne od stanu', async () => {
  const { app, db } = nowyPanel();
  try {
    const m=odczyt({ db, integracje:[{id:'dpd',skonfigurowana:true,zrodlo:'serwer'}] });
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({usluga:'dpd',stan:'niesprawdzone',ostatniSukcesAt:null,zrodlo:'serwer'});
  } finally { await app.close(); db.close(); }
});
it('atrpa piaskownicy nie jest dowodem rzeczywistego działania', async () => {
  const { app, db } = nowyPanel();
  try {
    db.prepare('INSERT INTO stan_pollera(sklep,ostatni_przebieg_at) VALUES(?,?)').run('woo','2026-10-31T10:00:00Z');
    const m=odczyt({db,proba:true,kanaly:{sklepy:{woo:{}},kanaly:{}}});
    expect(m[0]).toMatchObject({atrapa:true,stan:'niesprawdzone'});
  } finally { await app.close(); db.close(); }
});
