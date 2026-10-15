import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { uruchomZegary } from '../../../src/core/zegary.ts';
import { zapiszWatek } from '../../../src/oms/db/allegro-watki.js';

// ⚠️⚠️ TA SAMA RODZINA, CO `tests/okablowanie-oms-status.test.js`. Testy uslug wstrzykuja
// zaleznosci WPROST, wiec swieca na zielono takze wtedy, gdy punkt wejscia nigdy ich nie
// uruchamia — a martwy poller wyglada DOKLADNIE tak samo jak brak wiadomosci w Allegro.
// To jest ta sama klasa pomylki, co `puls`, ktory „MUSI wrocic do src/oms.js".
// PRZ-029 (zgoda właściciela 2026-10-01): skan statyczny zastapiony rzeczywista kompozycja —
// zbudujOms + uruchomZegary z wstrzyknietym interwalem, zadnego serwera ani sieci.

const licz = vi.hoisted(() => ({ klient: 0, tokeny: 0, poller: [], czuwacz: [], sprawy: [] }));
vi.mock('../../../src/oms/allegro/client.js', async (oryginal) => {
  const m = await oryginal();
  return { ...m, createAllegroClient: (o) => { licz.klient++; return m.createAllegroClient(o); } };
});
vi.mock('../../../src/oms/allegro/tokeny.js', async (oryginal) => {
  const m = await oryginal();
  return { ...m, createTokeny: (o) => { licz.tokeny++; return m.createTokeny(o); } };
});
vi.mock('../../../src/moduly/wiadomosci/services/poller-wiadomosci.js', async (oryginal) => {
  const m = await oryginal();
  return { ...m, createPollerWiadomosci: (o) => { const u = m.createPollerWiadomosci(o); licz.poller.push({ o, u }); return u; } };
});
vi.mock('../../../src/moduly/wiadomosci/services/czuwacz-formulki.js', async (oryginal) => {
  const m = await oryginal();
  return { ...m, createCzuwaczFormulki: (o) => { const u = m.createCzuwaczFormulki(o); licz.czuwacz.push({ o, u }); return u; } };
});
vi.mock('../../../src/moduly/wiadomosci/services/dyskusje.js', async (oryginal) => {
  const m = await oryginal();
  return { ...m, createOdswiezanieSpraw: (o) => { const u = m.createOdswiezanieSpraw(o); licz.sprawy.push({ o, u }); return u; } };
});

const kanalyEnv = [{ klucz: 'rynek', typ: 'allegro', prefiks: 'RYNEK' }, { klucz: 'targ', typ: 'allegro', prefiks: 'TARG' }];
const env = { OMS_USER: 'operator', OMS_PASS: 'fixture',
  OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000',
  OMS_PROFORMY_KATALOG: tmpdir(), OMS_ETYKIETY_KATALOG: tmpdir(), OMS_KANALY: JSON.stringify(kanalyEnv),
  RYNEK_CLIENT_ID: 'fikcyjny', RYNEK_CLIENT_SECRET: 'fikcyjny', RYNEK_USER_AGENT: 'Fixture/1.0 (+https://fixture.invalid)', RYNEK_OD: '2026-01-01',
  TARG_CLIENT_ID: 'fikcyjny', TARG_CLIENT_SECRET: 'fikcyjny', TARG_USER_AGENT: 'Fixture/1.0 (+https://fixture.invalid)', TARG_OD: '2026-01-01' };
const auth = { authorization: `Basic ${Buffer.from('operator:fixture').toString('base64')}` };

let a, kanaly, transport;
const interwaly = [];
beforeAll(async () => {
  transport = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Sieć zabroniona'));
  a = await zbudujOms({ env });
  kanaly = a.usluga('kanaly', 'klienciKanalow');
  uruchomZegary(a.zegary, { ustawInterwal: (fn, ms) => { interwaly.push({ fn, ms }); return 0; }, log: () => {} });
});
afterAll(async () => {
  try { if (a) await a.app.close(); } finally { a?.db.close(); transport.mockRestore(); }
});
// interwaly[i] należy do a.zegary[i] — uruchomZegary rejestruje je w kolejności tablicy.
const tyknij = async (nazwa) => {
  const i = a.zegary.findIndex((z) => z.nazwa === nazwa);
  if (i < 0) return { odstep: undefined, przebiegi: 0 };
  const przebieg = vi.spyOn(a.usluga('wiadomosci', nazwa), 'przebieg').mockResolvedValue({});
  try { await interwaly[i].fn(); return { odstep: interwaly[i].ms, przebiegi: przebieg.mock.calls.length }; }
  finally { przebieg.mockRestore(); }
};

describe('okablowanie: wiadomości Allegro', () => {
  it('punkt wejścia przekazuje poller wiadomości do zegarów', async () => {
    expect(await tyknij('pollerWiadomosci')).toEqual({ odstep: 300000, przebiegi: 1 });
  });

  it('punkt wejścia przekazuje czuwacz formułki do zegarów', async () => {
    expect(await tyknij('czuwaczFormulki')).toEqual({ odstep: 120000, przebiegi: 1 });
  });

  it('bootstrap oddaje obie usługi na zewnątrz', () => {
    expect({ n: licz.poller.length, ta: a.usluga('wiadomosci', 'pollerWiadomosci') === licz.poller[0]?.u })
      .toEqual({ n: 1, ta: true });
    expect({ n: licz.czuwacz.length, ta: a.usluga('wiadomosci', 'czuwaczFormulki') === licz.czuwacz[0]?.u })
      .toEqual({ n: 1, ta: true });
  });

  it('serwer dostaje klientów wiadomości — bez tego zakładka nie ma czym wysłać', async () => {
    zapiszWatek(a.db, { kanal: 'rynek', threadId: 'W-1', interlocutorLogin: 'kupujacy-fikcyjny',
      lastMessageDateTime: '2026-10-01T10:00:00Z', ostatniaOdKupujacego: true, ostatniaTresc: 'Pytanie' });
    const wyslij = vi.spyOn(kanaly.rynek, 'wyslijWiadomosc').mockResolvedValue({});
    try {
      const r = await a.app.inject({ method: 'POST', url: '/wiadomosci/rynek/W-1/odpowiedz',
        headers: { ...auth, origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'potwierdzam=tak&tresc=Dzie%C5%84%20dobry' });
      expect({ status: r.statusCode, wywolania: wyslij.mock.calls }).toEqual({ status: 302, wywolania: [['W-1', 'Dzień dobry']] });
    } finally { wyslij.mockRestore(); }
  });

  // ⚠️⚠️ DRUGA INSTANCJA `createAllegroClient` NA KANAL to druga deduplikacja odswiezania
  // we wlasnej `WeakMap` — dokladnie ta droga, ktora w nocy 13/14.08.2026 SPALILA refresh
  // token kanalu `allegro_szkicownia`. Nowe uslugi MUSZA brac istniejaca mape `klienciKanalow`.
  it('usługi biorą ISTNIEJĄCĄ mapę klientów, a nie własne instancje', () => {
    expect(licz.poller[0]?.o.klienci).toBe(kanaly);
    expect(licz.czuwacz[0]?.o.klienci).toBe(kanaly);
    expect({ klient: licz.klient, tokeny: licz.tokeny }).toEqual({ klient: kanalyEnv.length, tokeny: kanalyEnv.length });
  });

  it('odświeżanie spraw jest podpięte do przebiegu pollera, a nie do własnego zegara', () => {
    expect({ n: licz.sprawy.length, klienci: licz.sprawy[0]?.o.klienci === kanaly,
      usluga: a.usluga('wiadomosci', 'odswiezanieSpraw') === licz.sprawy[0]?.u }).toEqual({ n: 1, klienci: true, usluga: true });
    expect({ sprawyPollera: licz.poller[0]?.o.sprawy === licz.sprawy[0]?.u,
      zegarSpraw: a.zegary.some((z) => z.nazwa === 'odswiezanieSpraw') }).toEqual({ sprawyPollera: true, zegarSpraw: false });
  });
});
