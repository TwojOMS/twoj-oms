// PRZ-123 C06 — strażnik testów (setupFiles w vitest.config.ts): żaden test ani atrapa nie łączy się z MF.
// Każde żądanie na `mf.gov.pl` / `*.mf.gov.pl` (KSeF produkcyjny, testowy, przedprodukcyjny) przez poniższe
// drogi kończy się wyjątkiem „ZABRONIONE: KSeF w teście”, zanim gniazdo wywoła swój lookup:
//   - `globalThis.fetch` (napis, URL, Request);
//   - `net.Socket.prototype.connect` — przez nie idą net.connect/createConnection, tls.connect,
//     http/https i wewnętrzny undici (fetch). Łatamy prototyp, nie eksporty modułu, więc działa
//     także dla kodu, który zapamiętał `net.connect` przed nami.
// Czego NIE łapie: bezpośredniego `dns.lookup` / `dns.promises.lookup` (samo zapytanie DNS, bez połączenia)
// oraz procesów potomnych (spawn, fork, Worker) — setupFiles działa tylko w procesie testu. Tam chroni skan
// plików w tests/core/straznik-adresow-mf-prz123.test.js: żaden plik w tests/ i deploy/proba/ nie zawiera
// adresu MF poza atrybutem xmlns UPO i jawną listą wyjątków.
import { Socket } from 'node:net';

const ZNACZNIK = Symbol.for('twoj-oms.bez-ksef-mf');

/** Czy host to MF (`mf.gov.pl` albo jego poddomena), bez względu na wielkość liter i kropkę na końcu. */
export function czyHostMf(host: unknown): boolean {
  if (typeof host !== 'string') return false;
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  return h === 'mf.gov.pl' || h.endsWith('.mf.gov.pl');
}

function hostZCelu(cel: unknown): string | null {
  let napis: string;
  if (cel instanceof URL) napis = cel.href;
  else if (typeof cel === 'object' && cel !== null && 'url' in cel) napis = String((cel as { url: unknown }).url);
  else napis = String(cel);
  try {
    return new URL(napis).hostname;
  } catch {
    return null;
  }
}

function hostZArgumentow(args: unknown[]): string | null {
  // net.connect przekazuje znormalizowane argumenty jako tablicę `[opcje, cb]`.
  const pierwszy = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof pierwszy === 'object' && pierwszy !== null) {
    const opcje = pierwszy as { host?: unknown, hostname?: unknown };
    const host = opcje.host ?? opcje.hostname;
    return typeof host === 'string' ? host : null;
  }
  // connect(port, host, cb)
  return typeof args[1] === 'string' ? args[1] : null;
}

function zabronione(co: string, host: string): Error {
  return new Error(`ZABRONIONE: KSeF w teście — ${co} na ${host}. Testy i atrapy nie łączą się z MF; `
    + 'KSeF wyłącznie przez atrapę (tests/pomoc/atrapa-ksef-wysylki.js).');
}

const globalny = globalThis as typeof globalThis & { [ZNACZNIK]?: true };
if (!globalny[ZNACZNIK]) {
  globalny[ZNACZNIK] = true;

  const fetchOryginalny = globalThis.fetch;
  const fetchBezMf = async (cel: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const host = hostZCelu(cel);
    if (host && czyHostMf(host)) throw zabronione('fetch', host);
    return fetchOryginalny(cel, init);
  };
  globalThis.fetch = fetchBezMf as typeof fetch;

  const connectOryginalny = Socket.prototype.connect as (this: Socket, ...args: unknown[]) => Socket;
  const connectBezMf = function connectBezMf(this: Socket, ...args: unknown[]): Socket {
    const host = hostZArgumentow(args);
    if (host && czyHostMf(host)) throw zabronione('połączenie', host);
    return connectOryginalny.apply(this, args);
  };
  Socket.prototype.connect = connectBezMf as typeof Socket.prototype.connect;
}
