// PRZ-093 — OMS lokalnie na laptopie wykonawcy: zmyślona firma demo („Pracownia Półcień”), atrapy integracji
// (deploy/proba/atrapy — ta sama droga co piaskownica), tylko 127.0.0.1, baza w katalogu tymczasowym.
// Opis dla agenta: .claude/skills/run-oms/SKILL.md. Test: tests/instalacja/uruchom-lokalnie.test.js.
//
//   node scripts/uruchom-lokalnie.mjs start [--port N] [--katalog K]   świeże demo + serwer w tle; JSON w ostatniej linii
//   node scripts/uruchom-lokalnie.mjs stan  [--katalog K]
//   node scripts/uruchom-lokalnie.mjs stop  [--katalog K] [--zostaw] [--sila]
//   node scripts/uruchom-lokalnie.mjs zaloguj [--katalog K] [--wazny-sek N]   jednorazowy link wejścia (bez hasła w wyjściu)
//
// zaloguj: agent NIE czyta konto.json i nie widzi hasła. Proces serwera (tylko ten uruchomiony przez `start`)
// trzyma drugi nasłuch na 127.0.0.1:<portWejscia>; polecenie `zaloguj` zapisuje w <katalog>/wejscie.json skrót
// losowego tokenu i czas ważności (domyślnie 120 s) i drukuje link http://127.0.0.1:<portWejscia>/wejscie/<token>.
// Pierwsze otwarcie linku: serwer loguje się kontem z konto.json zwykłą trasą /login i oddaje przeglądarce
// ciasteczko sesji (HttpOnly) z przekierowaniem na panel; plik wejscie.json znika PRZED logowaniem, więc
// drugi użytek tego samego linku nie loguje. Cookie nie izoluje portów (RFC 6265 §8.5) — ciasteczko ustawione
// przez port wejścia obowiązuje na porcie panelu. Nic w src/ — produkcja, piaskownica i demo tego nie mają.
//
// Katalog domyślny: <tmp>/oms-lokalnie-<skrót ścieżki tej kopii repo> — każda kopia robocza (worktree) ma własny,
// więc kilku wykonawców naraz nie dzieli bazy; bez --port wybierany jest wolny port. Nic nie trafia do kopii repo.
// Konto: administrator `lokalny`, hasło losowe w <katalog>/konto.json (ginie razem z katalogiem przy stop).
// Dzieciak procesu dostaje WYŁĄCZNIE zmienne systemowe z białej listy + ENV_DEMO — żaden klucz integracji
// z powłoki wykonawcy nie przecieka (zresztą OMS_TRYB=proba odmawia startu z kluczem).
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const TEN_PLIK = fileURLToPath(import.meta.url);
const HOST = '127.0.0.1';
const LOGIN = 'lokalny';
const WAZNOSC_LINKU_SEK = 120;
const ZMIENNE_SYSTEMU = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'ComSpec', 'COMSPEC',
  'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'TZ'];

function opcje(argv) {
  const o = { komenda: argv[0], port: null, katalog: null, zostaw: false, sila: false, waznySek: WAZNOSC_LINKU_SEK };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') o.port = Number(argv[++i]);
    else if (a === '--wazny-sek') o.waznySek = Number(argv[++i]);
    else if (a === '--katalog') o.katalog = path.resolve(argv[++i]);
    else if (a === '--zostaw') o.zostaw = true;
    else if (a === '--sila') o.sila = true;
    else throw new Error(`nieznany argument: ${a}`);
  }
  if (o.port !== null && !(Number.isInteger(o.port) && o.port > 0 && o.port < 65536)) throw new Error('--port: liczba 1–65535');
  if (!(Number.isInteger(o.waznySek) && o.waznySek >= 1 && o.waznySek <= 600)) throw new Error('--wazny-sek: liczba 1–600');
  o.katalog ??= path.join(os.tmpdir(), `oms-lokalnie-${createHash('sha1').update(REPO.toLowerCase()).digest('hex').slice(0, 10)}`);
  return o;
}

const pliki = (k) => ({ baza: path.join(k, 'oms.sqlite'), stan: path.join(k, 'stan.json'), konto: path.join(k, 'konto.json'),
  wejscie: path.join(k, 'wejscie.json'),
  log: path.join(k, 'serwer.log'), proformy: path.join(k, 'proformy'), etykiety: path.join(k, 'etykiety') });
const wypisz = (obiekt) => console.log(JSON.stringify(obiekt));
const czytajJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const zyje = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const czekaj = (ms) => new Promise((ok) => setTimeout(ok, ms));

function portWolny(port) {
  return new Promise((ok) => {
    const s = net.createServer();
    s.once('error', () => ok(false));
    s.listen(port, HOST, () => s.close(() => ok(true)));
  });
}
function wolnyPort() {
  return new Promise((ok, zle) => {
    const s = net.createServer();
    s.once('error', zle);
    s.listen(0, HOST, () => { const { port } = s.address(); s.close(() => ok(port)); });
  });
}
async function odpowiada(adres) {
  try { const r = await fetch(`${adres}/health`, { signal: AbortSignal.timeout(3000) }); return r.status; } catch { return null; }
}
function usunKatalog(k) {
  fs.rmSync(k, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
function srodowisko(p, port) {
  const env = {};
  for (const k of ZMIENNE_SYSTEMU) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, OMS_DB_PATH: p.baza, OMS_PORT: String(port), OMS_PROFORMY_KATALOG: p.proformy, OMS_ETYKIETY_KATALOG: p.etykiety,
    // Konto serwisowe (Basic) gaśnie po pierwszym koncie w bazie — tu jest od razu, więc hasło nikomu niepotrzebne.
    OMS_USER: 'serwis-lokalny', OMS_PASS: randomBytes(24).toString('base64url') };
}

async function start(o) {
  const p = pliki(o.katalog);
  const stan = czytajJson(p.stan);
  if (stan && zyje(stan.pid) && await odpowiada(stan.adres)) {
    if (o.port !== null && o.port !== stan.port) throw new Error(`w ${o.katalog} działa już serwer na porcie ${stan.port} — najpierw stop`);
    wypisz({ status: 'juz-dziala', ...stan });
    return;
  }
  if (stan && zyje(stan.pid)) throw new Error(`proces ${stan.pid} z ${p.stan} żyje, ale nie odpowiada — sprawdź go albo stop --sila`);
  const port = o.port ?? await wolnyPort();
  if (!await portWolny(port)) throw new Error(`port ${port} zajęty — wybierz inny (--port) albo pomiń --port`);
  const t0 = Date.now();
  usunKatalog(o.katalog); // resztki po poprzednim przebiegu (proces nie żyje) — zawsze świeże demo
  for (const k of [p.proformy, p.etykiety]) fs.mkdirSync(k, { recursive: true });

  const { ENV_DEMO, utworzBazeDemo } = await import('./demo-dane.mjs');
  const { zalozKonto } = await import('../src/core/bezpieczenstwo/konta.js');
  const { DatabaseSync } = await import('node:sqlite');
  const env = { ...srodowisko(p, port), ...ENV_DEMO };
  const dzis = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
  await utworzBazeDemo({ baza: p.baza, dzis, env });
  const haslo = randomBytes(18).toString('base64url');
  const db = new DatabaseSync(p.baza);
  try { zalozKonto(db, { login: LOGIN, imie: 'Administrator lokalny', haslo, rola: 'administrator', admin: true }); }
  finally { db.close(); }
  const adres = `http://${HOST}:${port}`;
  fs.writeFileSync(p.konto, JSON.stringify({ adres, login: LOGIN, haslo }, null, 2) + '\n', { mode: 0o600 });
  const msBaza = Date.now() - t0;

  const wyjscie = fs.openSync(p.log, 'a');
  let portWejscia = await wolnyPort();
  while (portWejscia === port) portWejscia = await wolnyPort();
  const dziecko = spawn(process.execPath, [TEN_PLIK, 'serwer', '--wejscie', String(portWejscia), '--katalog', o.katalog], {
    cwd: REPO, env, detached: true, windowsHide: true, stdio: ['ignore', wyjscie, wyjscie],
  });
  fs.closeSync(wyjscie);
  let koniec = null;
  dziecko.once('exit', (kod) => { koniec = kod ?? 'sygnał'; });
  dziecko.unref();
  const nowyStan = { pid: dziecko.pid, port, portWejscia, adres, katalog: o.katalog, log: p.log, plikKonta: p.konto, login: LOGIN,
    repo: REPO, uruchomiony: new Date().toISOString() };
  fs.writeFileSync(p.stan, JSON.stringify(nowyStan, null, 2) + '\n');

  const limit = Date.now() + 60000;
  while (Date.now() < limit) {
    if (koniec !== null) break;
    if (await odpowiada(adres)) {
      wypisz({ status: 'dziala', ...nowyStan, msBaza, msRazem: Date.now() - t0 });
      return;
    }
    await czekaj(250);
  }
  const ogon = fs.existsSync(p.log) ? fs.readFileSync(p.log, 'utf8').slice(-3000) : '';
  if (koniec === null && zyje(dziecko.pid)) process.kill(dziecko.pid);
  throw new Error(`serwer nie wstał (${koniec !== null ? `zakończył się kodem ${koniec}` : 'brak odpowiedzi w 60 s'}); log ${p.log}:\n${ogon}`);
}

async function stop(o) {
  const p = pliki(o.katalog);
  const stan = czytajJson(p.stan);
  if (!stan || !zyje(stan.pid)) {
    if (!o.zostaw) usunKatalog(o.katalog);
    wypisz({ status: 'nie-dziala', katalog: o.katalog, ...(stan ? { pid: stan.pid, port: stan.port } : {}) });
    return;
  }
  // PID z pliku mógł zostać przydzielony innemu procesowi (restart laptopa) — zabijamy tylko, gdy pod portem
  // z tego samego pliku odpowiada panel, albo na wyraźne --sila.
  if (!o.sila && !await odpowiada(stan.adres)) {
    throw new Error(`proces ${stan.pid} żyje, ale ${stan.adres} nie odpowiada — to może nie być OMS; sprawdź i użyj stop --sila`);
  }
  process.kill(stan.pid, 'SIGTERM');
  const limit = Date.now() + 15000;
  while (Date.now() < limit && (zyje(stan.pid) || !await portWolny(stan.port))) {
    if (Date.now() > limit - 10000 && zyje(stan.pid) && process.platform !== 'win32') process.kill(stan.pid, 'SIGKILL');
    await czekaj(200);
  }
  if (zyje(stan.pid)) throw new Error(`proces ${stan.pid} nie zakończył się w 15 s`);
  if (!o.zostaw) usunKatalog(o.katalog);
  wypisz({ status: 'zatrzymany', pid: stan.pid, port: stan.port, portWolny: await portWolny(stan.port), katalog: o.katalog,
    katalogUsuniety: !fs.existsSync(o.katalog) });
}

async function pokazStan(o) {
  const stan = czytajJson(pliki(o.katalog).stan);
  if (!stan) { wypisz({ status: 'nie-dziala', katalog: o.katalog }); return; }
  const health = zyje(stan.pid) ? await odpowiada(stan.adres) : null;
  wypisz({ status: health ? 'dziala' : 'nie-dziala', health, ...stan });
}

const skrot = (token) => createHash('sha256').update(token).digest();

async function zaloguj(o) {
  const stan = czytajJson(pliki(o.katalog).stan);
  if (!stan || !zyje(stan.pid) || !await odpowiada(stan.adres)) {
    throw new Error('serwer nie działa — najpierw: node scripts/uruchom-lokalnie.mjs start');
  }
  if (!stan.portWejscia) throw new Error('ten serwer wstał starszą wersją skryptu (bez wejścia) — stop, potem start');
  const token = randomBytes(24).toString('base64url');
  fs.writeFileSync(pliki(o.katalog).wejscie,
    JSON.stringify({ skrot: skrot(token).toString('hex'), wygasa: Date.now() + o.waznySek * 1000 }) + '\n', { mode: 0o600 });
  wypisz({ status: 'gotowe', link: `http://${HOST}:${stan.portWejscia}/wejscie/${token}`, jednorazowy: true, waznySek: o.waznySek,
    adres: stan.adres, uwaga: 'Link jest sekretem o krótkim życiu: otwórz go w przeglądarce raz; po tym nie loguje.' });
}

// Nasłuch wejścia: tylko w procesie serwera uruchomionym przez `start`. Hasło z konto.json czytane jest TUTAJ,
// w procesie serwera, i nie opuszcza go — przeglądarka dostaje wyłącznie ciasteczko sesji.
function uruchomWejscie({ port, portPanelu, katalog }) {
  const p = pliki(katalog);
  const adresPanelu = `http://${HOST}:${portPanelu}`;
  const odmow = (res, kod) => { res.writeHead(kod, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); res.end('brak dostępu\n'); };
  const serwer = http.createServer(async (req, res) => {
    try {
      // Obrona przed DNS rebinding: tylko adres, który wypisało `zaloguj`.
      if (req.method !== 'GET' || req.headers.host !== `${HOST}:${port}`) return odmow(res, 404);
      const dopasowanie = /^\/wejscie\/([A-Za-z0-9_-]{20,64})$/.exec(req.url ?? '');
      if (!dopasowanie) return odmow(res, 404);
      // Od odczytu do rmSync nie ma await — dwa równoległe żądania nie przejdą oba. Zły token niczego nie kasuje
      // (inaczej każdy proces na laptopie mógłby unieważniać cudzy link zgadywaniem); trafiony kasuje ZANIM
      // padnie logowanie, więc link jest jednorazowy także wtedy, gdy logowanie się nie uda.
      const zapis = czytajJson(p.wejscie);
      if (!zapis) return odmow(res, 410);
      if (!(zapis.wygasa > Date.now())) { fs.rmSync(p.wejscie, { force: true }); return odmow(res, 410); }
      const oczekiwany = Buffer.from(zapis.skrot, 'hex');
      const dany = skrot(dopasowanie[1]);
      if (oczekiwany.length !== dany.length || !timingSafeEqual(oczekiwany, dany)) return odmow(res, 410);
      fs.rmSync(p.wejscie, { force: true });
      const konto = czytajJson(p.konto);
      const odpowiedz = await fetch(`${adresPanelu}/login`, { method: 'POST', redirect: 'manual',
        headers: { origin: adresPanelu, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ uzytkownik: konto?.login ?? '', haslo: konto?.haslo ?? '', powrot: '/' }) });
      const ciasteczko = odpowiedz.headers.getSetCookie().find((c) => c.startsWith('sesja_oms_proba='));
      if (odpowiedz.status !== 302 || !ciasteczko) return odmow(res, 502);
      res.writeHead(302, { 'set-cookie': ciasteczko, location: `${adresPanelu}/`, 'cache-control': 'no-store' });
      res.end();
    } catch { odmow(res, 500); }
  });
  return new Promise((ok, zle) => {
    serwer.once('error', zle);
    serwer.listen(port, HOST, () => ok(() => new Promise((koniec) => { serwer.closeAllConnections(); serwer.close(koniec); })));
  });
}

// Tryb wewnętrzny: proces serwera (start go odpala). Ta sama złożona aplikacja co piaskownica, tylko na 127.0.0.1.
async function serwer(argv) {
  const w = { wejscie: null, katalog: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--wejscie') w.wejscie = Number(argv[++i]);
    else if (argv[i] === '--katalog') w.katalog = argv[++i];
  }
  const zamknijWejscie = w.wejscie && w.katalog
    ? await uruchomWejscie({ port: w.wejscie, portPanelu: Number(process.env.OMS_PORT), katalog: w.katalog })
    : async () => {};
  const { uruchomPiaskownice } = await import('../deploy/proba/atrapy/index.mjs');
  const { zamknij } = await uruchomPiaskownice(process.env, { host: HOST });
  const zakoncz = () => { void zamknijWejscie().then(zamknij).finally(() => process.exit(0)); };
  process.once('SIGINT', zakoncz);
  process.once('SIGTERM', zakoncz);
  console.log(`OMS lokalnie na http://${HOST}:${process.env.OMS_PORT} — tryb proba, integracje: atrapy`);
}

const KOMENDY = { start, stop, stan: pokazStan, zaloguj };
const argv = process.argv.slice(2);
try {
  if (argv[0] === 'serwer') await serwer(argv.slice(1));
  else {
    const o = opcje(argv);
    if (!KOMENDY[o.komenda]) throw new Error('użycie: node scripts/uruchom-lokalnie.mjs start|stan|stop|zaloguj [--port N] [--katalog K] [--zostaw] [--sila] [--wazny-sek N]');
    await KOMENDY[o.komenda](o);
  }
} catch (e) {
  console.error(`uruchom-lokalnie: ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
}
