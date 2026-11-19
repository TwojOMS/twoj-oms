// Operacja „pobierz-cenniki” sklepu ERLI: odświeża tylko nazwy cenników dostaw i datę pobrania; metod dostawy,
// mapy metod ani punktów nadania nie rusza. Transport to atrapa — żadne żądanie nie wychodzi do ERLI.
import { afterEach, expect, it, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { migracjaKanalowSprzedazy } from '../../../src/moduly/kanaly/migracje/0001-kanaly-sprzedazy.ts';
import { migracjaTypuKanaluISklepow } from '../../../src/moduly/kanaly/migracje/0003-kanaly-typ-sklepy.ts';
import { createSklepyErli } from '../../../src/moduly/kanaly/services/sklepy-erli.ts';

const aktor = { id: 1, login: 'admin' };
const T = '2026-11-11T12:00:00.000Z';
const METODY = [{ id: 'dpd', nazwa: 'DPD', erli: false, vendor: 'dpd' }];
const MAPA = { dpd: { kurier: 'dpd' } };
const bazy: ReturnType<typeof openOmsDb>[] = [];
afterEach(() => {
  for (const db of bazy.splice(0)) db.close();
});

type Odpowiedz = (db: ReturnType<typeof openOmsDb>) => Response;
async function setup(cenniki: Odpowiedz, zPliku = false) {
  const db = openOmsDb();
  bazy.push(db);
  migracjaKanalowSprzedazy.wykonaj(db);
  migracjaTypuKanaluISklepow.wykonaj(db);
  const zapytania: string[] = [];
  const fetchImpl = vi.fn(async (u: unknown) => {
    const p = new URL(String(u)).pathname;
    zapytania.push(p);
    if (p.endsWith('/me')) return Response.json({ id: 123, name: 'Lampy Półcień' });
    if (p.endsWith('/delivery/priceListsDetails')) return cenniki(db);
    return new Response('{}', { status: 500 });
  });
  const sklepy = createSklepyErli({
    db,
    teraz: () => new Date(T),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    definicje: zPliku ? [{ klucz: 'erli_lampy_plik' }] : [],
    ustawieniaEnv: zPliku
      ? { erli_lampy_plik: { adresApi: 'https://sandbox.erli.dev/svc/shop-api', kluczApi: 'fikcyjny-klucz' } }
      : {},
  });
  const wersja = (k: string) => Number(sklepy.pobierz(k)!.wersja);
  const utworzone = await sklepy.operacja(
    'nowe',
    'dane',
    {
      wersja: 0,
      nazwa: 'Lampy Półcień',
      adresApi: 'https://sandbox.erli.dev/svc/shop-api',
      kluczApi: 'fikcyjny-klucz',
      domyslnyCzasWysylki: '3',
    },
    aktor,
  );
  expect(utworzone.ok).toBe(true);
  const k = (utworzone as { klucz: string }).klucz;
  expect((await sklepy.operacja(k, 'sprawdz', { wersja: wersja(k) }, aktor)).ok).toBe(true);
  db.prepare(
    `UPDATE konfiguracja_integracji SET ustawienia_json = json_set(ustawienia_json, '$.metodySklepu', json(?),
      '$.mapaMetod', json(?), '$.cennikiDostaw', json(?)) WHERE integracja = ?`,
  ).run(JSON.stringify(METODY), JSON.stringify(MAPA), JSON.stringify(['Stary cennik']), 'erli:' + k);
  zapytania.length = 0;
  return { db, sklepy, k, wersja, zapytania };
}

it('zapisuje nazwy cenników i datę pobrania, metod dostawy i mapy metod nie rusza', async () => {
  const { sklepy, k, wersja, zapytania } = await setup(() =>
    Response.json([
      { name: 'Paczkomat A', prices: [{ deliveryMethod: { id: 'paczkomat' } }] },
      { name: ' Kurier gabaryt ', prices: [] },
      { name: 'Paczkomat A', prices: [] },
      { name: 'Zły\u0007cennik', prices: [] },
      { prices: [] },
    ]),
  );
  const przed = wersja(k);
  const w = await sklepy.operacja(k, 'pobierz-cenniki', { wersja: przed }, aktor);
  expect(w).toEqual({ ok: true, klucz: k });
  expect(zapytania).toEqual(['/svc/shop-api/delivery/priceListsDetails']);
  const u = sklepy.pobierz(k)!.ustawienia;
  expect(u.cennikiDostaw).toEqual(['Paczkomat A', 'Kurier gabaryt']);
  expect(u.cennikiPobranoAt).toBe(T);
  expect(u.metodySklepu).toEqual(METODY);
  expect(u.mapaMetod).toEqual(MAPA);
  expect(wersja(k)).toBe(przed + 1);
});

it('zły klucz (401) → komunikat o kluczu, nic nie zapisane', async () => {
  const { sklepy, k, wersja } = await setup(() => new Response('{}', { status: 401 }));
  const przed = wersja(k);
  const w = await sklepy.operacja(k, 'pobierz-cenniki', { wersja: przed }, aktor);
  expect(w).toMatchObject({
    ok: false,
    status: 400,
    komunikat: 'Nieprawidłowy klucz API. Sprawdź klucz w panelu ERLI.',
  });
  expect(sklepy.pobierz(k)!.ustawienia.cennikiDostaw).toEqual(['Stary cennik']);
  expect(sklepy.pobierz(k)!.ustawienia.cennikiPobranoAt).toBeUndefined();
  expect(wersja(k)).toBe(przed);
});

it('odpowiedź, która nie jest listą → komunikat o pobraniu, nic nie zapisane', async () => {
  const { sklepy, k, wersja } = await setup(() => Response.json({ name: 'Paczkomat A' }));
  const w = await sklepy.operacja(k, 'pobierz-cenniki', { wersja: wersja(k) }, aktor);
  expect(w).toMatchObject({
    ok: false,
    status: 400,
    komunikat: 'Nie udało się pobrać cenników z ERLI. Spróbuj ponownie.',
  });
  expect(sklepy.pobierz(k)!.ustawienia.cennikiDostaw).toEqual(['Stary cennik']);
});

it('połączenie zmienione w trakcie pobierania → 409, nic nie zapisane', async () => {
  let klucz = '';
  const { sklepy, k, wersja } = await setup((db) => {
    db.prepare('UPDATE kanaly_sprzedazy SET wersja = wersja + 1 WHERE klucz = ?').run(klucz);
    return Response.json([{ name: 'Paczkomat A', prices: [] }]);
  });
  klucz = k;
  const w = await sklepy.operacja(k, 'pobierz-cenniki', { wersja: wersja(k) }, aktor);
  expect(w).toMatchObject({ ok: false, status: 409 });
  expect(sklepy.pobierz(k)!.ustawienia.cennikiDostaw).toEqual(['Stary cennik']);
});

it('nieaktualny formularz → 409 bez żądania do ERLI', async () => {
  const { sklepy, k, wersja, zapytania } = await setup(() => Response.json([]));
  const w = await sklepy.operacja(k, 'pobierz-cenniki', { wersja: wersja(k) - 1 }, aktor);
  expect(w).toMatchObject({ ok: false, status: 409 });
  expect(zapytania).toEqual([]);
});

it('konto niesprawdzone → 409 bez żądania do ERLI', async () => {
  const { db, sklepy, k, wersja, zapytania } = await setup(() => Response.json([]));
  db.prepare(
    `UPDATE konfiguracja_integracji SET ustawienia_json = json_set(ustawienia_json, '$.sprawdzono', json('false'))
    WHERE integracja = ?`,
  ).run('erli:' + k);
  const w = await sklepy.operacja(k, 'pobierz-cenniki', { wersja: wersja(k) }, aktor);
  expect(w).toMatchObject({
    ok: false,
    status: 409,
    komunikat: 'Najpierw sprawdź połączenie i rozwiąż kolizję sklepu.',
  });
  expect(zapytania).toEqual([]);
});
