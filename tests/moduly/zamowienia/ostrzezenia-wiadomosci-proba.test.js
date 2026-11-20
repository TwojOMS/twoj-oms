// Wiadomość od kupującego nie jest ostrzeżeniem ani powiadomieniem — sygnalizuje ją licznik przy „Wiadomości”
// w menu (wątki czekające na odpowiedź). Drugi sygnał o tym samym w tabelce uczyłby ignorowania obu.
// Strona główna przez HTTP, zegar podawany (fałszywa data), dane zmyślone — bez sieci.
import { afterEach, it, expect, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { zapiszWatek } from '../../../src/oms/db/allegro-watki.js';
import { nowyPanel, jako, get } from '../../pomoc/panel-konta-testowe.js';

const panele = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const p of panele.splice(0)) {
    await p.app.close();
    p.db.close();
  }
});

const TEKST = 'Nowa wiadomość z Allegro od kupujacy-testowy';

function panel(env = {}) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-28T10:00:00.000Z'));
  const db = openOmsDb(':memory:');
  const p = nowyPanel({ db, env });
  panele.push(p);
  zalozKonto(db, { login: 'admin-test', imie: 'Administrator', haslo: 'h', rola: 'administrator', admin: true });
  zapiszWatek(db, {
    kanal: 'allegro_swietlik',
    threadId: 'w-167',
    interlocutorLogin: 'kupujacy-testowy',
    lastMessageDateTime: '2026-10-28T08:00:00.000Z',
    ostatniaOdKupujacego: true,
    ostatniaTresc: 'Dzień dobry, pytanie o rozmiar.',
    pobranyAt: '2026-10-28T08:01:00.000Z',
  });
  return { ...p, admin: jako(db, 'admin-test') };
}

it('nowa wiadomość nie daje wiersza ostrzeżenia na liście zamówień', async () => {
  const { app, admin } = panel();
  const r = await get(app, '/', admin);
  expect(r.statusCode).toBe(200);
  expect(r.body).not.toContain(TEKST);
  expect(r.body).not.toContain('ostrzezenie--wiadomosc-allegro');
});

it('plakietka licznika przy „Wiadomości” w menu jest poza próbą', async () => {
  const poza = panel();
  expect((await get(poza.app, '/', poza.admin)).body).toContain('oms-wiadomosci-licznik');
});
