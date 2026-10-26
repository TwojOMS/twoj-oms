import { expect, vi, onTestFinished } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, Socket } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { uruchomOms } from '../../src/main.ts';
import { zbudujOms } from '../../src/oms/bootstrap.ts';
import * as tokeny from '../../src/oms/allegro/tokeny.js';

export const OCZEKIWANE_ZEGARY = [
  ['poller', 120000], ['czuwaczKsef', 3600000], ['czuwaczArchiwumSprzedazy', 3600000],
  ['pollerWiadomosci', 300000], ['czuwaczFormulki', 120000], ['czuwaczPrzesylek', 3600000],
  ['czuwaczPodjazdow', 600000], ['czuwaczKosztow', 3600000], ['czuwaczOstrzezen', 3600000],
  ['czuwaczReklam', 3600000],
  // PRZ-102.12: automat wysyłki do KSeF (tyka co minutę, sam rozstrzyga porę; domyślnie wyłączony).
  ['automatKsef', 60000],
  // PRZ-108.07: silnik reguł automatyzacji (co minutę; przy zerze reguł jedno SELECT, zero zapisów).
  ['automatyzacje', 60000],
  // PRZ-117: ponawianie statusu po błędzie przejściowym Allegro/sklepu (co 15 min).
  ['ponawianieStatusow', 900000],
] as const;

function lokalneEnv(klucze = false) {
  const katalog = mkdtempSync(join(tmpdir(), 'prz030-produkt-'));
  return {
    OMS_TRYB: klucze ? 'produkcja' : 'proba', OMS_DB_PATH: join(katalog, 'oms.sqlite'), OMS_PORT: '0',
    OMS_USER: 'operator', OMS_PASS: 'atrapa', OMS_SPRZEDAWCA_NIP: '1234563218',
    OMS_RACHUNEK: '34109010140000000000000000', OMS_KANALY: klucze
      ? '[{"klucz":"allegro_fixture","typ":"allegro","prefiks":"ALLEGRO_FIXTURE"}]' : '[]',
    OMS_ETYKIETY_KATALOG: katalog, OMS_PROFORMY_KATALOG: katalog,
    ...(klucze ? {
      ALLEGRO_FIXTURE_CLIENT_ID: 'atrapa', ALLEGRO_FIXTURE_CLIENT_SECRET: 'atrapa',
      ALLEGRO_FIXTURE_USER_AGENT: 'PrzykladowyPanel/0.0.0 (+https://przyklad.invalid/panel)',
      ALLEGRO_FIXTURE_OD: '2026-07-01', INFAKT_API_KEY: 'atrapa', INFAKT_ARCHIWUM: katalog,
      KSEF_TOKEN: 'atrapa',
    } : {}),
  };
}

function bezSieci() {
  const proby: string[] = [];
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    proby.push('fetch'); throw Error('PRZ030: ZABRONIONE WYJŚCIE DO SIECI');
  });
  const socketSpy = vi.spyOn(Socket.prototype, 'connect').mockImplementation(function () {
    proby.push('socket'); throw Error('PRZ030: ZABRONIONE WYJŚCIE DO SIECI');
  });
  return () => {
    fetchSpy.mockRestore(); socketSpy.mockRestore();
    expect(proby, 'kompozycja wykonała wychodzący fetch/socket').toEqual([]);
  };
}

export async function wykonajWejscie() {
  const lifecycle = new AbortController();
  let probe: ReturnType<typeof createServer> | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let exited: Promise<unknown> | undefined;
  let operation: Promise<[string, number, string][]>;
  let output = '', errors = '';
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => cleanupPromise ??= (async () => {
    lifecycle.abort();
    try {
      if (probe) {
        await new Promise<void>((resolve, reject) => probe!.close(error => {
          if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
          else resolve();
        }));
      }
    } finally {
      if (child) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        await exited;
        expect(child.exitCode === 0 || child.signalCode === 'SIGTERM', `Exit ${child.exitCode}/${child.signalCode}: ${errors}`).toBe(true);
      }
    }
  })();
  onTestFinished(async () => {
    lifecycle.abort();
    await operation.catch(() => undefined);
  });
  operation = (async () => {
    const wyniki: [string, number, string][] = [];
    try {
      probe = createServer();
      const listening = once(probe, 'listening', { signal: lifecycle.signal });
      probe.listen(0, '127.0.0.1');
      await listening;
      const port = (probe.address() as { port: number }).port;
      await new Promise<void>((resolve, reject) => probe!.close(e => e ? reject(e) : resolve()));
      lifecycle.signal.throwIfAborted();
      const env = { ...lokalneEnv(), OMS_PORT: String(port) };
      const preload = new URL('./blokada-sieci-entrypoint.mjs', import.meta.url).href;
      child = spawn(process.execPath, ['--import', preload, 'src/oms.js'], {
        cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env,
      });
      const ownChild = child;
      ownChild.stdout!.on('data', chunk => { output += chunk; });
      ownChild.stderr!.on('data', chunk => { errors += chunk; });
      exited = once(ownChild, 'exit');
      // Attach rejection handling immediately; finally still awaits the same exit promise.
      void exited.catch(() => undefined);
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(deadline);
          ownChild.stdout!.off('data', ready);
          ownChild.off('exit', failed);
          ownChild.off('error', failedSpawn);
          lifecycle.signal.removeEventListener('abort', aborted);
          error ? reject(error) : resolve();
        };
        const ready = (chunk: Buffer) => { if (String(chunk).includes('OMS na :')) finish(); };
        const failed = (code: number | null) => finish(Error(`Start exit ${code}: ${errors}`));
        const failedSpawn = (error: Error) => finish(error);
        const aborted = () => finish(Error('PRZ030: odbiór entrypointu anulowany'));
        const deadline = setTimeout(() => finish(Error(`Brak startu: ${output}\n${errors}`)), 15000);
        ownChild.stdout!.on('data', ready);
        ownChild.once('exit', failed);
        ownChild.once('error', failedSpawn);
        lifecycle.signal.addEventListener('abort', aborted, { once: true });
        if (lifecycle.signal.aborted) aborted();
      });
      const auth = { authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}` };
      const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: lifecycle.signal });
      expect(health.status).toBe(200); expect(await health.json()).toMatchObject({ ok: true });
      for (const url of ['/ustawienia/zamowienia-i-wysylka', '/faktury', '/magazyn', '/raporty', '/wiadomosci']) {
        const response = await fetch(`http://127.0.0.1:${port}${url}`, { headers: auth, signal: lifecycle.signal });
        const title = /<title>([^<]+)<\/title>/.exec(await response.text())?.[1] ?? '';
        wyniki.push([url, response.status, title]);
      }
    } finally {
      await cleanup();
    }
    expect(errors).not.toContain('ZABRONIONE WYJŚCIE DO SIECI');
    return wyniki;
  })();
  return operation;
}

export async function wykonajZegary(nazwa?: string) {
  const zakonczBlokade = bezSieci();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  let wynik: Awaited<ReturnType<typeof uruchomOms>> | undefined;
  try {
    wynik = await uruchomOms(lokalneEnv(true), '127.0.0.1');
    const a = wynik.aplikacja;
    const uslugi: Record<string, any> = {
      poller: a.usluga('kanaly', 'poller'), czuwaczKsef: a.usluga('faktury', 'czuwaczKsef'),
      czuwaczArchiwumSprzedazy: a.usluga('faktury', 'czuwaczArchiwumSprzedazy'),
      pollerWiadomosci: a.usluga('wiadomosci', 'pollerWiadomosci'), czuwaczFormulki: a.usluga('wiadomosci', 'czuwaczFormulki'),
      czuwaczPrzesylek: a.usluga('wysylka', 'czuwaczPrzesylek'), czuwaczPodjazdow: a.usluga('wysylka', 'czuwaczPodjazdow'),
      czuwaczKosztow: a.usluga('koszty', 'czuwaczKosztow'), czuwaczOstrzezen: a.usluga('zdrowie', 'czuwaczOstrzezen'),
      czuwaczReklam: a.usluga('marketing', 'czuwaczReklam'),
    };
    const spies = Object.fromEntries(Object.entries(uslugi).map(([n, u]) => [n, vi.spyOn(u, 'przebieg').mockResolvedValue({ pominiety: false })]));
    const nazwy = a.zegary.map(z => [z.nazwa, z.odstepMs]).sort();
    const liczba = vi.getTimerCount();
    if (nazwa) {
      await vi.advanceTimersByTimeAsync(3599999); expect(spies[nazwa]).toHaveBeenCalledTimes(0);
      await vi.advanceTimersByTimeAsync(1); expect(spies[nazwa]).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(3600000); expect(spies[nazwa]).toHaveBeenCalledTimes(2);
    }
    await wynik.zamknij();
    expect(vi.getTimerCount()).toBe(0);
    if (nazwa) { await vi.advanceTimersByTimeAsync(3600000); expect(spies[nazwa]).toHaveBeenCalledTimes(2); }
    return { nazwy, liczba };
  } finally {
    await wynik?.zamknij(); vi.useRealTimers(); zakonczBlokade();
  }
}

export async function wykonajJednaFabrykeTokenow() {
  const zakonczBlokade = bezSieci();
  const spy = vi.spyOn(tokeny, 'createTokeny');
  let wynik: Awaited<ReturnType<typeof zbudujOms>> | undefined;
  try {
    const env = lokalneEnv(true);
    wynik = await zbudujOms({ env });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ db: wynik.db, kanal: 'allegro_fixture' });
    const headers = { authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}` };
    expect((await wynik.app.inject({ method: 'GET', url: '/ustawienia/integracje', headers })).statusCode).toBe(200);
    expect((await wynik.app.inject({ method: 'GET', url: '/', headers })).statusCode).toBe(200);
    expect(wynik.usluga<() => unknown[]>('kanaly', 'stanyKanalow')()).toHaveLength(1);
    return spy.mock.calls.length;
  } finally {
    await wynik?.app.close(); wynik?.db.close(); spy.mockRestore(); zakonczBlokade();
  }
}
