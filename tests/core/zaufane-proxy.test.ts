import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { zbudujAplikacje } from '../../src/core/aplikacja.ts';
import { zaufaneProxy } from '../../src/core/zaufane-proxy.ts';
import { zbudujOms } from '../../src/oms/bootstrap.ts';
import { uruchomOms } from '../../src/main.ts';
import { modulRdzen } from '../../src/moduly/rdzen/modul.ts';
import type { ModulOms } from '../../src/core/kontrakty.ts';

const env = {
  OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000',
  OMS_USER: 'operator', OMS_PASS: 'poprawne', OMS_PROFORMY_KATALOG: 'C:/tmp/proformy',
  OMS_ETYKIETY_KATALOG: 'C:/tmp/etykiety',
};
const aplikacje: Awaited<ReturnType<typeof zbudujOms>>[] = [];

afterEach(async () => {
  for (const a of aplikacje.splice(0)) {
    await a.app.close();
    a.db.close();
  }
});

async function zbuduj(dodatkowe: Record<string, string | undefined> = {}) {
  const a = await zbudujOms({ env: { ...env, ...dodatkowe } });
  aplikacje.push(a);
  return a;
}

const przezProxy = (ip: string) => ({ remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': ip } });
const odNadawcy = (nadawca: string, ip: string) => ({ remoteAddress: nadawca, headers: { 'x-forwarded-for': ip } });
const basic = (haslo: string) => ({ authorization: `Basic ${Buffer.from(`operator:${haslo}`).toString('base64')}` });

describe('OMS_TRUST_PROXY', () => {
  it('oddziela hamulce Basic Auth oraz formularza dla klientów za zaufanym proxy', async () => {
    const a = await zbuduj({ OMS_TRUST_PROXY: '127.0.0.1' });

    const basicZle: number[] = [];
    for (let i = 0; i < 6; i++) basicZle.push((await a.app.inject({ method: 'GET', url: '/ustawienia/konta', ...przezProxy('198.51.100.10'), headers: { ...przezProxy('198.51.100.10').headers, ...basic('zle') } })).statusCode);
    expect(basicZle).toEqual([401, 401, 401, 401, 401, 429]);
    expect((await a.app.inject({ method: 'GET', url: '/ustawienia/konta', ...przezProxy('198.51.100.11'), headers: { ...przezProxy('198.51.100.11').headers, ...basic('poprawne') } })).statusCode).toBe(200);

    const formularzZle: number[] = [];
    for (let i = 0; i < 5; i++) formularzZle.push((await a.app.inject({ method: 'POST', url: '/login', ...przezProxy('198.51.100.20'), headers: { ...przezProxy('198.51.100.20').headers, origin: 'http://localhost' }, payload: { uzytkownik: 'operator', haslo: 'zle' } })).statusCode);
    expect(formularzZle).toEqual([401, 401, 401, 401, 429]);
    expect((await a.app.inject({ method: 'POST', url: '/login', ...przezProxy('198.51.100.21'), headers: { ...przezProxy('198.51.100.21').headers, origin: 'http://localhost' }, payload: { uzytkownik: 'operator', haslo: 'poprawne' } })).statusCode).toBe(302);
  });

  it('bez zaufanej listy nie pozwala obejść hamulców zmianą X-Forwarded-For', async () => {
    const a = await zbuduj();
    for (let i = 0; i < 5; i++) expect((await a.app.inject({ method: 'GET', url: '/ustawienia/konta', ...przezProxy(`198.51.100.${i}`), headers: { ...przezProxy(`198.51.100.${i}`).headers, ...basic('zle') } })).statusCode).toBe(401);
    expect((await a.app.inject({ method: 'GET', url: '/ustawienia/konta', ...przezProxy('198.51.100.99'), headers: { ...przezProxy('198.51.100.99').headers, ...basic('zle') } })).statusCode).toBe(429);
  });

  it('nie ufa nagłówkowi od niezaufanego nadawcy mimo skonfigurowanej listy', async () => {
    const a = await zbuduj({ OMS_TRUST_PROXY: '127.0.0.1' });
    for (let i = 0; i < 5; i++) expect((await a.app.inject({ method: 'GET', url: '/ustawienia/konta', ...odNadawcy('192.0.2.1', `198.51.100.${i}`), headers: { ...odNadawcy('192.0.2.1', `198.51.100.${i}`).headers, ...basic('zle') } })).statusCode).toBe(401);
    expect((await a.app.inject({ method: 'GET', url: '/ustawienia/konta', ...odNadawcy('192.0.2.1', '198.51.100.99'), headers: { ...odNadawcy('192.0.2.1', '198.51.100.99').headers, ...basic('zle') } })).statusCode).toBe(429);

    for (let i = 0; i < 4; i++) expect((await a.app.inject({ method: 'POST', url: '/login', ...odNadawcy('192.0.2.2', `203.0.113.${i}`), headers: { ...odNadawcy('192.0.2.2', `203.0.113.${i}`).headers, origin: 'http://localhost' }, payload: { uzytkownik: 'operator', haslo: 'zle' } })).statusCode).toBe(401);
    expect((await a.app.inject({ method: 'POST', url: '/login', ...odNadawcy('192.0.2.2', '203.0.113.99'), headers: { ...odNadawcy('192.0.2.2', '203.0.113.99').headers, origin: 'http://localhost' }, payload: { uzytkownik: 'operator', haslo: 'zle' } })).statusCode).toBe(429);
  });

  it.each(['true', '*', '0.0.0.0/0', '::/0', '0.0.0.0/1,128.0.0.0/1', '::/1,8000::/1', '::ffff:0.0.0.0/1,8000::/1', '::ffff:0.0.0.0/96', '::ffff:0:0/96', '198.51.100.0/33', 'sekret-niepoprawnej-konfiguracji'])('odmawia %j przed migracjami bez wypisania wartości', async (wartosc) => {
    let dotknietoDb = false;
    const proba = zbudujAplikacje({
      moduly: [modulRdzen] as unknown as ModulOms[],
      env: { OMS_SPRZEDAWCA_NIP: env.OMS_SPRZEDAWCA_NIP, OMS_RACHUNEK: env.OMS_RACHUNEK, OMS_TRUST_PROXY: wartosc },
      get db(): DatabaseSync { dotknietoDb = true; throw Error('DB nie może zostać otwarta'); },
    });
    await expect(proba).rejects.toThrow('OMS_TRUST_PROXY');
    await expect(proba).rejects.not.toThrow(wartosc);
    expect(dotknietoDb).toBe(false);
  });

  it('przyjmuje tylko natywne zakresy IPv4 i IPv6', () => {
    expect(zaufaneProxy({ OMS_TRUST_PROXY: '127.0.0.1/32,::1/128' })).toEqual(['127.0.0.1/32', '::1/128']);
  });

  it('entrypoint odmawia błędnego proxy przed utworzeniem lub zmianą bazy', async () => {
    const katalog = mkdtempSync(join(tmpdir(), 'oms-proxy-preflight-'));
    const nowa = join(katalog, 'nowa.sqlite');
    const istniejaca = join(katalog, 'istniejaca.sqlite');
    const przed = Buffer.from('własna-baza-próby-bez-migracji');
    writeFileSync(istniejaca, przed);
    try {
      for (const plik of [nowa, istniejaca]) {
        const proba = async () => {
          const uruchomiona = await uruchomOms({ ...env, OMS_DB_PATH: plik, OMS_PORT: '0', OMS_TRUST_PROXY: '*' }, '127.0.0.1');
          await uruchomiona.zamknij();
        };
        await expect(proba()).rejects.toThrow('OMS_TRUST_PROXY');
      }
      expect(existsSync(nowa)).toBe(false);
      expect(readFileSync(istniejaca).equals(przed)).toBe(true);
    } finally {
      const cel = resolve(katalog);
      if (resolve(tmpdir()) !== resolve(join(cel, '..')) || !cel.includes('oms-proxy-preflight-')) throw Error('Nieprawidłowy własny TEMP');
      rmSync(cel, { recursive: true, force: true });
    }
  });
});
