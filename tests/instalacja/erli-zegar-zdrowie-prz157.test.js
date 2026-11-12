import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { zbudujAplikacje } from '../../src/core/aplikacja.ts';
import { uruchomZegary } from '../../src/core/zegary.ts';
import { ustawRejestrKanalow } from '../../src/domena/moduly-kanalow.ts';
import { modulyPiaskownicy } from '../../deploy/proba/atrapy/index.mjs';
import { przygotujUruchomienieSandbox } from '../../deploy/proba/sandbox-uruchomienie.ts';
import { ENV_DEMO, wygenerujDaneDemo } from '../../scripts/demo-dane.mjs';
import { drogaErliDlaZamowienia } from '../../src/moduly/kanaly/services/kanal-erli.ts';

let db, aplikacja, katalog;
let zegary = [];
afterEach(async () => {
  zegary.forEach(clearInterval);
  zegary = [];
  vi.useRealTimers();
  await aplikacja?.app.close();
  db?.close();
  if (katalog) rmSync(katalog, { recursive: true, force: true });
  ustawRejestrKanalow(null);
  vi.restoreAllMocks();
});

it.each(['demo', 'sandbox'])('%s: zegar importuje ERLI, a health widzi aktywne źródło przed pierwszym przebiegiem', async profil => {
  const siec = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Test: sieć zabroniona'));
  katalog = mkdtempSync(new URL('../../.tmp-erli-zegar-', import.meta.url));
  const env = { ...ENV_DEMO, OMS_USER: 'test', OMS_PASS: 'fikcyjne',
    OMS_PROFORMY_KATALOG: join(katalog, 'proformy'), OMS_ETYKIETY_KATALOG: join(katalog, 'etykiety') };
  const plan = profil === 'sandbox' ? przygotujUruchomienieSandbox(env, { srodowisko: 'sandbox' }, siec) : null;
  const moduly = plan?.moduly ?? modulyPiaskownicy(env, { baza: () => db });
  db = openOmsDb(':memory:', { moduly });
  wygenerujDaneDemo(db, { dzis: '2026-11-11', env });
  aplikacja = await zbudujAplikacje({ db, env, moduly, teraz: () => new Date('2026-11-11T12:00:00Z'),
    ...(plan ? { nadpisania: plan.nadpisania(db) } : {}), log: () => {} });
  const liczba = () => db.prepare("SELECT count(*) n FROM zamowienia WHERE sklep='erli_polcien'").get().n;
  const health = async () => (await aplikacja.app.inject({ method: 'GET', url: '/health' })).json();
  const zrodla = async () => (await health()).poller.zrodla.map(z => z.zrodlo);
  expect(liczba()).toBe(0);
  expect(await zrodla()).toContain('erli_polcien');
  // Rzeczywisty zegar modułu; 30 sekund z objawu to mniej niż domyślny interwał 120 s.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  zegary = uruchomZegary(aplikacja.zegary.filter(z => z.nazwa === 'poller'));
  await vi.advanceTimersByTimeAsync(30_000);
  expect(liczba()).toBe(0);
  await vi.advanceTimersByTimeAsync(90_000);
  expect(liczba()).toBe(15);
  const zamowienia = db.prepare("SELECT * FROM zamowienia WHERE sklep='erli_polcien'").all();
  const drogi = zamowienia.map(z => drogaErliDlaZamowienia(db, z));
  expect(drogi.some(d => d?.droga === 'przesylki_erli')).toBe(true);
  expect(drogi.some(d => d?.droga === 'umowa' && d.kurier === 'dpd')).toBe(true);
  expect(drogi.some(d => d?.droga === 'blokada')).toBe(true);
  expect(siec).not.toHaveBeenCalled();
  expect(await zrodla()).toContain('erli_polcien');
  db.prepare("UPDATE kanaly_sprzedazy SET pobieranie='wylaczone' WHERE klucz='erli_polcien'").run();
  expect(await zrodla()).not.toContain('erli_polcien');
  db.prepare("UPDATE kanaly_sprzedazy SET pobieranie='wlaczone' WHERE klucz='erli_polcien'").run();
  expect(await zrodla()).toContain('erli_polcien');
});
