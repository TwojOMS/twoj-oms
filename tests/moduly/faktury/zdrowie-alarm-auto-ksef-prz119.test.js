import { afterEach, describe, expect, it, vi } from 'vitest';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { utworzAlarmAutoKsef } from '../../../src/moduly/faktury/db/alarm-auto-ksef.js';

afterEach(() => vi.unstubAllGlobals());

async function panel(skonfigurowana = true) {
  const siec = vi.fn(() => { throw new Error('Test zdrowia nie może korzystać z sieci'); });
  vi.stubGlobal('fetch', siec);
  const env = {
    OMS_USER: 'fixture', OMS_PASS: 'fixture', OMS_KANALY: '[]',
    OMS_PROFORMY_KATALOG: 'tests/fixture-proformy', OMS_ETYKIETY_KATALOG: 'tests/fixture-etykiety',
    OMS_PROGRAM_FAKTUROWY: 'fakturownia',
    ...(skonfigurowana ? { FAKTUROWNIA_DOMENA: 'konto-fikcyjne-11912', FAKTUROWNIA_API_TOKEN: 'fikcyjny-token-11912' } : {}),
  };
  let faktury;
  const moduly = modulyDla(env).map((m) => m.nazwa !== 'faktury' ? m : {
    ...m,
    zbuduj(ctx) { faktury = m.zbuduj(ctx); return faktury; },
  });
  const p = await zbudujOms({ env, moduly, log: () => {} });
  return { ...p, zdrowieFaktur: () => faktury.zdrowie(), siec, alarm: utworzAlarmAutoKsef(p.db) };
}

describe('PRZ-119.12a alarm auto-KSeF w zdrowiu faktur', () => {
  it('bez wpisów nie alarmuje; dopisanie alarmuje do zgaszenia przez operatora', async () => {
    const p = await panel();
    try {
      expect(p.zdrowieFaktur()).toMatchObject({ alarmy: [], ok: true });
      p.alarm.dopisz({ dokument: '1', numer: 'FV 1/11/2026', gov_status: 'processing' });
      p.alarm.dopisz({ dokument: '2', numer: 'FV 2/11/2026', gov_status: 'sent' });
      const stan = p.zdrowieFaktur();
      expect(stan.ok).toBe(false);
      expect(stan.alarmy).toHaveLength(1);
      expect(stan.alarmy[0]).toContain('Fakturownia wysłała do KSeF 2');
      expect(stan.alarmy[0]).not.toContain('FV 2/11/2026');
      expect(stan.alarmy[0]).toContain('Sprawdziłem');
      expect(stan.alarmy[0]).toContain('/ustawienia/integracje/fakturownia');
      expect(stan.alarmy[0]).not.toMatch(/fikcyjny-token|konto-fikcyjne|\d{4}-\d{2}-\d{2}T/u);
      expect(stan.uwagi.join(' ')).not.toContain('bez zlecenia z panelu');
      p.alarm.zgas();
      expect(p.zdrowieFaktur()).toMatchObject({ alarmy: [], ok: true });
      expect(p.siec).not.toHaveBeenCalled();
    } finally { await p.app.close(); p.db.close(); }
  });

  it('/health pokazuje alarm i ok=false do zgaszenia', async () => {
    const p = await panel();
    try {
      const zdrowie = async () => (await p.app.inject({ method: 'GET', url: '/health' })).json();
      expect((await zdrowie()).alarmy.join(' ')).not.toContain('bez zlecenia z panelu');
      p.alarm.dopisz({ dokument: '4', numer: 'FV 4/11/2026', gov_status: 'processing' });
      const z = await zdrowie();
      expect(z.ok).toBe(false);
      expect(z.alarmy.filter((a) => a.includes('Fakturownia wysłała do KSeF 1'))).toHaveLength(1);
      // PRZ-119.12h: zbiorczy raport zdrowia (faktury + zdrowie) też raz, nie dwa razy.
      expect(p.zdrowie().alarmy.filter((a) => a.includes('Fakturownia wysłała do KSeF 1'))).toHaveLength(1);
      p.alarm.zgas();
      expect((await zdrowie()).alarmy.join(' ')).not.toContain('bez zlecenia z panelu');
      expect(p.siec).not.toHaveBeenCalled();
    } finally { await p.app.close(); p.db.close(); }
  });

  it('liczy dokumenty bez numeru tak samo', async () => {
    const p = await panel();
    try {
      p.alarm.dopisz({ dokument: '3', gov_status: 'processing' });
      expect(p.zdrowieFaktur().alarmy[0]).toContain('Fakturownia wysłała do KSeF 1');
      expect(p.siec).not.toHaveBeenCalled();
    } finally { await p.app.close(); p.db.close(); }
  });

  it('bez klienta Fakturowni pomija nawet zapisany alarm', async () => {
    const p = await panel(false);
    try {
      p.alarm.dopisz({ dokument: '1', numer: 'FV 1/11/2026', gov_status: 'processing' });
      expect(p.zdrowieFaktur()).toMatchObject({ alarmy: [], ok: true });
      expect(p.siec).not.toHaveBeenCalled();
    } finally { await p.app.close(); p.db.close(); }
  });
});
