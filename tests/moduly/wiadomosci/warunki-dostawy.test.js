import { it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { klientPoNip } from '../../../src/oms/db/klienci.js';
const headers = { authorization: `Basic ${Buffer.from('tester:x').toString('base64')}`, origin: 'http://localhost' };
it('niezależne przełączniki: pusta kwota odmawia, odznaczona ignoruje przesłaną kwotę', async () => {
  const db = openOmsDb(':memory:');
  const app = buildOmsServer({ db, config: { auth: { user: 'tester', pass: 'x' } } });
  try {
    const payload = {
      nazwa: 'Pracownia Półcień',
      nip: '1234500011',
      metoda_wysylki: 'dpd',
      platnosc: 'przelew',
      prog_darmowej_dostawy_wlaczony: 'on',
      prog_darmowej_dostawy: '',
      oplata_obslugi: '4',
    };
    const odmowa = await app.inject({ method: 'POST', url: '/klienci', headers, payload });
    expect(odmowa.statusCode).toBe(400);
    expect(odmowa.body).toContain('próg darmowej dostawy');
    const zapis = await app.inject({
      method: 'POST',
      url: '/klienci',
      headers,
      payload: { ...payload, prog_darmowej_dostawy: '500' },
    });
    expect(zapis.statusCode).toBe(302);
    const klient = klientPoNip(db, payload.nip);
    expect(klient).toMatchObject({ rozliczenie_zbiorcze: 0, prog_darmowej_dostawy_gr: 50000, oplata_obslugi_gr: null });
    const ekran = await app.inject({ method: 'GET', url: `/klienci/${klient.id}`, headers });
    expect(ekran.statusCode).toBe(200);
    expect(ekran.body).not.toContain('name="oplata_kurierska"');
    expect(ekran.body).toMatch(
      /type="checkbox"[^>]*name="prog_darmowej_dostawy_wlaczony"[^>]*aria-controls="prog-dostawy"[^>]*checked/,
    );
    expect(ekran.body).toContain('id="prog-dostawy"');
  } finally {
    await app.close();
    db.close();
  }
});
it('obsługa działa bez rozliczenia zbiorczego i zachowuje włączone zero w edycji', async () => {
  const db = openOmsDb(':memory:');
  const app = buildOmsServer({ db, config: { auth: { user: 'tester', pass: 'x' } } });
  try {
    const payload = {
      nazwa: 'Półcień Zero',
      nip: '1234500011',
      metoda_wysylki: 'dpd',
      platnosc: 'przelew',
      oplata_obslugi_wlaczony: 'on',
      oplata_obslugi: '',
      prog_darmowej_dostawy: '500',
    };
    const odmowa = await app.inject({ method: 'POST', url: '/klienci', headers, payload });
    expect(odmowa.statusCode).toBe(400);
    expect(odmowa.body).toContain('opłatę za obsługę');
    const zapis = await app.inject({
      method: 'POST',
      url: '/klienci',
      headers,
      payload: { ...payload, oplata_obslugi: '0' },
    });
    expect(zapis.statusCode).toBe(302);
    const klient = klientPoNip(db, payload.nip);
    expect(klient).toMatchObject({ rozliczenie_zbiorcze: 0, prog_darmowej_dostawy_gr: null, oplata_obslugi_gr: 0 });
    const ekran = await app.inject({ method: 'GET', url: `/klienci/${klient.id}`, headers });
    expect(ekran.statusCode).toBe(200);
    expect(ekran.body).toMatch(
      /type="checkbox"[^>]*name="oplata_obslugi_wlaczony"[^>]*aria-controls="oplata-obslugi"[^>]*checked/,
    );
    expect(ekran.body).toContain('value="0.00"');
  } finally {
    await app.close();
    db.close();
  }
});
