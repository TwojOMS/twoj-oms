import { afterEach, expect, it, vi } from 'vitest';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { zbudujAplikacje } from '../../src/core/aplikacja.ts';
import { modulyPiaskownicy, nadpisaniaPiaskownicy } from '../../deploy/proba/atrapy/index.mjs';
import { ENV_DEMO, wygenerujDaneDemo } from '../../scripts/demo-dane.mjs';
import { MODULY_KANALOW, ustawRejestrKanalow } from '../../src/domena/moduly-kanalow.ts';
import { strzezErliProby, transportErliPiaskownicy } from '../../deploy/proba/atrapy/erli.mjs';

// PRZ-157.11a: oficjalne adresy API (erli.pl i sandbox.erli.dev /svc/shop-api) z kluczem atrapy obsługuje w próbie
// atrapa konfiguratora w procesie (bez sieci). Straż ma odmówić każdemu innemu adresowi ERLI przed wysyłką.
const ADRES_ERLI_POZA_KONFIGURATOREM = 'https://erli.pl/svc/inne-api';
let db, aplikacja;
afterEach(async () => { await aplikacja?.app.close(); db?.close(); ustawRejestrKanalow(null); vi.restoreAllMocks(); });

it.each(['https://erli.pl/svc/shop-api/me', 'https://sandbox.erli.dev/svc/shop-api/me',
  'https://api.erli.pl./svc/shop-api/me', 'https://api.erli.dev/svc/shop-api/me',
  'https://sub.sandbox.erli.dev/svc/shop-api/me'])('straż odmawia %s przed wysyłką', async adres => {
  const fetchImpl = vi.fn(async () => new Response('{}'));
  await expect(strzezErliProby({ fetchImpl })(adres)).rejects.toMatchObject({ name: 'OdmowaHosta', message: expect.stringMatching(/Tryb próby.*ERLI/) });
  expect(fetchImpl).not.toHaveBeenCalled();
});

// PRZ-157.12g (recenzja): kreator woła transport wprost, więc to on musi zabronić przekierowań z sandboxa.
it('transport: sandbox z własnym kluczem wychodzi bez przekierowań, klucz nie zmienia adresu', async () => {
  const fetchImpl = vi.fn(async () => Response.json({ id: 1, name: 'x' }));
  const transport = transportErliPiaskownicy({ baza: () => null, env: { OMS_TRYB: 'proba' }, log: undefined, fetchImpl });
  await transport('https://sandbox.erli.dev/svc/shop-api/me', { headers: { Authorization: 'Bearer klucz-testowy' } });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(fetchImpl.mock.calls[0][0]).toBe('https://sandbox.erli.dev/svc/shop-api/me');
  expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
});

it.each(['demo', 'profil Sandbox'])('%s: sandbox z własnym kluczem idzie do sieci, atrapa i produkcja bez sieci', async sklad => {
  const siec = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ id: 1000001, name: 'sandbox-polcien' }));
  const wstrzyknietyFetch = vi.fn(async () => Response.json({ id: 1000001, name: 'sandbox-polcien' }));
  const env = { ...ENV_DEMO, OMS_TRYB: 'proba' };
  const { przygotujUruchomienieSandbox } = await import('../../deploy/proba/sandbox-uruchomienie.ts');
  const plan = sklad === 'demo' ? null : przygotujUruchomienieSandbox(env, { srodowisko: 'sandbox' }, wstrzyknietyFetch);
  const wyjscie = plan ? wstrzyknietyFetch : siec;
  const moduly = plan?.moduly ?? modulyPiaskownicy(env, { baza: () => db });
  db = openOmsDb(':memory:', { moduly });
  wygenerujDaneDemo(db, { dzis: '2026-11-11', env });
  const k = db.prepare("SELECT * FROM kanaly_sprzedazy WHERE typ='erli'").get();
  aplikacja = await zbudujAplikacje({ db, env, moduly: moduly.filter(m => ['rdzen', 'kanaly'].includes(m.nazwa)),
    nadpisania: plan?.nadpisania(db) ?? nadpisaniaPiaskownicy({ db, env, log: () => {} }), log: () => {} });
  ustawRejestrKanalow(klucz => klucz === k.klucz ? 'erli' : null, MODULY_KANALOW);
  const klient = (adresApi, kluczApi) => {
    db.prepare('UPDATE konfiguracja_integracji SET ustawienia_json=?, sekrety_json=? WHERE integracja=?')
      .run(JSON.stringify({ adresApi }), JSON.stringify({ kluczApi }), `erli:${k.klucz}`);
    db.prepare('UPDATE kanaly_sprzedazy SET generacja=generacja+1 WHERE klucz=?').run(k.klucz);
    return aplikacja.usluga('kanaly', 'rejestrKanalow').klient(k.klucz);
  };
  const sandbox = 'https://sandbox.erli.dev/svc/shop-api';
  await expect(klient(sandbox, 'fixture-sandbox-polcien').mojSklep()).resolves.toMatchObject({ name: 'sandbox-polcien' });
  expect(wyjscie).toHaveBeenCalledExactlyOnceWith(sandbox + '/me', expect.objectContaining({ redirect: 'error' }));
  expect(new Headers(wyjscie.mock.calls[0][1].headers).get('Authorization')).toBe('Bearer fixture-sandbox-polcien');
  if (plan) expect(siec).not.toHaveBeenCalled();
  wyjscie.mockClear();
  for (const adres of [sandbox, 'https://erli.pl/svc/shop-api']) {
    await expect(klient(adres, 'atrapa-polcien').mojSklep()).resolves.toMatchObject({ name: 'pracownia-polcien' });
  }
  for (const klucz of ['fixture-sandbox-polcien', 'dowolny-inny']) {
    await expect(klient('https://erli.pl/svc/shop-api', klucz).mojSklep()).rejects.toMatchObject({ status: 403 });
  }
  for (const adres of ['https://api.erli.dev/svc/shop-api', 'https://api.erli.pl/svc/shop-api',
    'http://sandbox.erli.dev/svc/shop-api', 'https://sandbox.erli.dev/inne-api']) {
    await expect(klient(adres, 'fixture-sandbox-polcien').mojSklep()).rejects.toMatchObject({ name: 'OdmowaHosta' });
  }
  expect(siec).not.toHaveBeenCalled();
  expect(wstrzyknietyFetch).not.toHaveBeenCalled();
});

it('reset demo tworzy kanał panelu; poller importuje 15 zamówień i kolejne zmiany bez duplikatów', async () => {
  const siec = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Test: sieć zabroniona'));
  const env = { ...ENV_DEMO };
  db = openOmsDb(':memory:', { moduly: modulyPiaskownicy(env, { baza: () => db }) });
  wygenerujDaneDemo(db, { dzis: '2026-11-11', env });
  const k = db.prepare("SELECT * FROM kanaly_sprzedazy WHERE typ='erli'").get();
  expect(k).toMatchObject({ nazwa: 'ERLI Półcień', zrodlo: 'panel', pobieranie: 'wlaczone', autoryzacja: 'polaczone' });
  expect(db.prepare('SELECT count(*) n FROM zamowienia WHERE sklep=?').get(k.klucz).n).toBe(0);
  aplikacja = await zbudujAplikacje({ db, env, moduly: modulyPiaskownicy(env, { baza: () => db }).filter(m => ['rdzen', 'kanaly'].includes(m.nazwa)),
    nadpisania: nadpisaniaPiaskownicy({ db, env, log: () => {} }), log: () => {} });
  ustawRejestrKanalow(klucz => klucz === k.klucz ? 'erli' : null, MODULY_KANALOW);
  const rejestr = aplikacja.usluga('kanaly', 'rejestrKanalow');
  await rejestr.przebiegZamowien();
  const zam = () => db.prepare('SELECT * FROM zamowienia WHERE sklep=? ORDER BY zrodlo_id').all(k.klucz);
  expect(zam()).toHaveLength(15);
  expect(zam().map(z => z.zrodlo_id)).not.toContain('PC-ERLI-0006');
  expect(zam().find(z => z.zrodlo_id === 'PC-ERLI-0005')).toMatchObject({ nip: '9994027180', chce_fakture: 1 });
  const de = JSON.parse(zam().find(z => z.zrodlo_id === 'PC-ERLI-0010').surowe_json);
  expect(de._oms.sprawy[0].tekst).toMatch(/rynku DE.*EUR/);
  expect(JSON.parse(zam().find(z => z.zrodlo_id === 'PC-ERLI-0009').klient_json).email).toBeFalsy();
  await rejestr.przebiegZamowien();
  expect(zam()).toHaveLength(15);
  expect(zam().find(z => z.zrodlo_id === 'PC-ERLI-0007').anulowane).toBe(1);
  expect(JSON.parse(zam().find(z => z.zrodlo_id === 'PC-ERLI-0008').surowe_json).status).toBe('returned');
  expect(JSON.parse(zam().find(z => z.zrodlo_id === 'PC-ERLI-0008').surowe_json).returns[0]).toMatchObject({ reason: 'resign', items: [{ index: 0, quantity: 1 }] });
  expect(JSON.parse(zam().find(z => z.zrodlo_id === 'PC-ERLI-0009').klient_json).email).toBe('kupujacy9@polcien.example');
  await rejestr.przebiegZamowien();
  expect(zam()).toHaveLength(15);
  db.prepare("UPDATE konfiguracja_integracji SET ustawienia_json=? WHERE integracja=?").run(JSON.stringify({ adresApi: ADRES_ERLI_POZA_KONFIGURATOREM }), `erli:${k.klucz}`);
  db.prepare('UPDATE kanaly_sprzedazy SET generacja=generacja+1 WHERE klucz=?').run(k.klucz);
  await expect(rejestr.klient(k.klucz).mojSklep()).rejects.toMatchObject({ name: 'OdmowaHosta' });
  expect(siec).not.toHaveBeenCalled();
});

it('profil Allegro Sandbox: kanał ERLI z panelu też importuje z atrapy (bez sieci), erli.pl nadal odmówione', async () => {
  const siec = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Test: sieć zabroniona'));
  const { przygotujUruchomienieSandbox } = await import('../../deploy/proba/sandbox-uruchomienie.ts');
  const env = { ...ENV_DEMO, OMS_TRYB: 'proba' };
  const allegro = vi.fn(async () => new Response('{}'));
  const plan = przygotujUruchomienieSandbox(env, { srodowisko: 'sandbox' }, allegro);
  db = openOmsDb(':memory:', { moduly: plan.moduly });
  wygenerujDaneDemo(db, { dzis: '2026-11-11', env });
  const k = db.prepare("SELECT * FROM kanaly_sprzedazy WHERE typ='erli'").get();
  aplikacja = await zbudujAplikacje({ db, env, moduly: plan.moduly.filter(m => ['rdzen', 'kanaly'].includes(m.nazwa)), nadpisania: plan.nadpisania(db), log: () => {} });
  ustawRejestrKanalow(klucz => klucz === k.klucz ? 'erli' : null, MODULY_KANALOW);
  await aplikacja.usluga('kanaly', 'rejestrKanalow').przebiegZamowien();
  expect(db.prepare('SELECT count(*) n FROM zamowienia WHERE sklep=?').get(k.klucz).n).toBe(15);
  db.prepare("UPDATE konfiguracja_integracji SET ustawienia_json=? WHERE integracja=?").run(JSON.stringify({ adresApi: ADRES_ERLI_POZA_KONFIGURATOREM }), `erli:${k.klucz}`);
  db.prepare('UPDATE kanaly_sprzedazy SET generacja=generacja+1 WHERE klucz=?').run(k.klucz);
  await expect(aplikacja.usluga('kanaly', 'rejestrKanalow').klient(k.klucz).mojSklep()).rejects.toMatchObject({ name: 'OdmowaHosta' });
  expect(siec).not.toHaveBeenCalled();
  expect(allegro).not.toHaveBeenCalled();
});
