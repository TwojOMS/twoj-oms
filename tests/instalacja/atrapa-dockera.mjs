// Atrapa dockera dla testów aktualizatora (PRZ-059). Stan (obrazy, tagi, kontenery) w pliku JSON,
// więc test sprawdza SKUTKI całej sekwencji, a nie kolejność wywołań. `docker run` naprawdę wykonuje
// node z kopia.mjs na prawdziwej bazie SQLite (ścieżki kontenera zamienione na ścieżki z -v).
// Zachowanie „obrazu” wynika z plików w katalogu wydania, z którego go zbudowano:
//   TEST_ZEPSUTY       — proces pada przy starcie: /health nie odpowiada, RestartCount rośnie
//   TEST_WISI          — kontener działa bez restartów, ale /health nie odpowiada (zawieszony start)
//   TEST_MIGRACJA      — przy starcie oms dopisuje addytywną migrację do bazy (jak kandydat z migracją)
//   TEST_BEZ_WERSJI    — /health bez pola wersja (wydanie sprzed PRZ-059)
//   TEST_INNY_KOD      — /health 200, ale w kontenerze inny kod (wydanie.json z innym commitem, wersja brak)
//   TEST_BUILD_BLAD    — build kończy się błędem
// Zmienne: TEST_BAZA (katalog testu), TEST_ZABIJ_PRZY (fragment polecenia → SIGKILL aktualizatora).
// PRZ-062 (przejście próba → praca): `up oms` czyta config/oms.env jak compose przy tworzeniu kontenera —
//   OMS_TRYB=produkcja na pustym data/ zakłada świeżą bazę (jak migracje OMS), linia TEST_NIE_WSTANIE=1
//   (konfiguracja odrzucona przez OMS) daje pętlę restartów; `exec oms node scripts/produkcja-pierwszy-start.mjs`
//   zakłada konto w bazie i wypisuje login/hasło (TEST_PIERWSZY_START_BLAD → kod 1); `compose exec -T kopia
//   node deploy/klient/kopia.mjs teraz` uruchamia PRAWDZIWY kopia.mjs na ścieżkach hosta; `logs` — atrapa.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const BAZA = process.env.TEST_BAZA;
const PLIK = path.join(BAZA, 'docker-stan.json');
const stan = fs.existsSync(PLIK) ? JSON.parse(fs.readFileSync(PLIK, 'utf8')) : { obrazy: {}, tagi: {}, kontenery: {}, wywolania: [], licznik: 0 };
const zapisz = () => fs.writeFileSync(PLIK, JSON.stringify(stan, null, 1));
const argv = process.argv.slice(2);
stan.wywolania.push(argv.join(' '));
zapisz();

function zabij() {
  const fragment = process.env.TEST_ZABIJ_PRZY;
  if (!fragment || !argv.join(' ').includes(fragment)) return;
  if (fs.existsSync(path.join(BAZA, 'zabito'))) return;
  fs.writeFileSync(path.join(BAZA, 'zabito'), argv.join(' '));
  const stanAkt = fs.readFileSync(path.join(process.env.OMS_KATALOG, 'update-state/blokada/stan'), 'utf8');
  const pid = /^pid=(\d+)$/m.exec(stanAkt)[1];
  if (process.platform === 'win32') spawnSync('C:/Program Files/Git/usr/bin/kill.exe', ['-9', pid]);
  else process.kill(Number(pid), 'SIGKILL');
  process.exit(137);
}
zabij();

const wyjdz = (kod, tekst = '') => { if (tekst) (kod ? process.stderr : process.stdout).write(tekst + '\n'); process.exit(kod); };
const NAZWY = { oms: 'oms', kopia: 'oms-kopia' };
const rozwiaz = ref => (ref.startsWith('sha256:') ? (stan.obrazy[ref] ? ref : null) : stan.tagi[ref] ?? null);
const korzenWydania = plikCompose => path.resolve(path.dirname(plikCompose), '../..');
const rewizjaZEnv = plikCompose => /OMS_REVISION=([0-9a-f]{40})/.exec(fs.readFileSync(path.join(path.dirname(plikCompose), '.env'), 'utf8'))[1];
const ma = (obraz, znacznik) => fs.existsSync(path.join(stan.obrazy[obraz].korzen, znacznik));

function format(fmt, obiekt) {
  // Zepsuty start: Docker restartuje kontener w kółko (restart: unless-stopped).
  if (fmt.includes('RestartCount')) return obiekt.kontener && (obiekt.kontener.zepsuty || ma(obiekt.kontener.obraz, 'TEST_ZEPSUTY')) ? '5' : '0';
  if (fmt.includes('.Image')) return obiekt.kontener.obraz;
  if (fmt.includes('.State.Running')) return String(obiekt.kontener.dziala);
  if (fmt.includes('.State.Status')) return obiekt.kontener.dziala ? 'running' : 'exited';
  if (fmt.includes('revision')) return stan.obrazy[obiekt.obraz]?.revision ?? '';
  if (fmt.includes('.Id')) return obiekt.obraz;
  if (fmt.includes('.Size')) return '438000000';
  return '';
}

function migruj(obraz) {
  const db = new DatabaseSync(path.join(process.env.OMS_KATALOG, 'data/oms.sqlite'));
  try {
    db.exec('CREATE TABLE IF NOT EXISTS proba_kandydata (id INTEGER PRIMARY KEY)');
    db.prepare('INSERT OR IGNORE INTO migracje (modul, numer, nazwa, zastosowana_at) VALUES (?, ?, ?, ?)').run('rdzen', 99, 'proba-kandydata', new Date().toISOString());
    db.prepare("INSERT INTO zamowienia (numer) VALUES (?)").run(`PO-KANDYDACIE-${stan.obrazy[obraz].revision.slice(0, 4)}`);
  } finally { db.close(); }
}

const konfiguracjaOms = () => { try { return fs.readFileSync(path.join(process.env.OMS_KATALOG, 'config/oms.env'), 'utf8'); } catch { return ''; } };
// Pusty katalog danych + tryb produkcja: OMS zakłada bazę migracjami (tu: te same tabele co instalacja testu).
function swiezaBaza() {
  const plik = path.join(process.env.OMS_KATALOG, 'data/oms.sqlite');
  if (fs.existsSync(plik)) return;
  const db = new DatabaseSync(plik);
  try {
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('CREATE TABLE migracje (modul TEXT, numer INTEGER, nazwa TEXT, zastosowana_at TEXT, PRIMARY KEY (modul, numer))');
    db.exec("INSERT INTO migracje VALUES ('rdzen', 1, 'baseline', '2026-10-01')");
    db.exec('CREATE TABLE zamowienia (id INTEGER PRIMARY KEY, numer TEXT)');
    db.exec('CREATE TABLE konta (login TEXT)');
  } finally { db.close(); }
}

const [polecenie, ...reszta] = argv;
if (polecenie === 'info') wyjdz(0, path.join(BAZA, 'docker-root'));
if (polecenie === 'compose') {
  const iF = reszta.indexOf('-f');
  const plikCompose = reszta[iF + 1];
  const po = reszta.slice(iF + 2);
  const [akcja, ...arg] = po;
  const uslugi = arg.filter(a => !a.startsWith('-'));
  if (akcja === 'build') {
    const korzen = korzenWydania(plikCompose);
    if (fs.existsSync(path.join(korzen, 'TEST_BUILD_BLAD'))) wyjdz(1, 'failed to solve: npm ci');
    const rev = rewizjaZEnv(plikCompose);
    const id = 'sha256:' + createHash('sha256').update(`${rev}-${stan.licznik++}`).digest('hex');
    stan.obrazy[id] = { revision: rev, korzen };
    stan.tagi[`oms:${rev}`] = id;
    zapisz(); wyjdz(0);
  }
  if (akcja === 'stop') {
    for (const u of uslugi.length ? uslugi : Object.keys(NAZWY)) if (stan.kontenery[NAZWY[u]]) stan.kontenery[NAZWY[u]].dziala = false;
    zapisz(); wyjdz(0);
  }
  if (akcja === 'up') {
    const rev = rewizjaZEnv(plikCompose);
    const obraz = stan.tagi[`oms:${rev}`];
    if (!obraz) wyjdz(1, `pull access denied for oms:${rev}`);
    for (const u of uslugi) {
      const env = konfiguracjaOms();
      stan.kontenery[NAZWY[u]] = { obraz, dziala: true, ...(u === 'oms' && /^TEST_NIE_WSTANIE=1$/m.test(env) ? { zepsuty: true } : {}) };
      if (u === 'oms' && ma(obraz, 'TEST_MIGRACJA')) migruj(obraz);
      if (u === 'oms' && /^OMS_TRYB=produkcja$/m.test(env) && !stan.kontenery.oms.zepsuty) swiezaBaza();
    }
    zapisz(); wyjdz(0);
  }
  if (akcja === 'exec') {
    const tekst = arg.join(' ');
    if (!tekst.includes('kopia.mjs teraz')) wyjdz(1, `atrapa: nieznane compose exec ${tekst}`);
    if (!stan.kontenery['oms-kopia']?.dziala) wyjdz(1, 'service "kopia" is not running');
    const O = process.env.OMS_KATALOG;
    const r = spawnSync(process.execPath, [path.join(korzenWydania(plikCompose), 'deploy/klient/kopia.mjs'), 'teraz'], { encoding: 'utf8',
      env: { ...process.env, OMS_DB_PATH: `${O}/data/oms.sqlite`, OMS_KOPIE_KATALOG: `${O}/backups`, OMS_ETYKIETY_KATALOG: `${O}/data/etykiety`, OMS_PROFORMY_KATALOG: `${O}/data/proformy` } });
    process.stdout.write(r.stdout ?? ''); process.stderr.write(r.stderr ?? '');
    process.exit(r.status ?? 1);
  }
  if (akcja === 'ps') wyjdz(0, Object.entries(stan.kontenery).map(([n, k]) => `${n} ${k.dziala ? 'Up' : 'Exited'}`).join('\n'));
  wyjdz(1, `atrapa: nieznane compose ${akcja}`);
}
if (polecenie === 'inspect') {
  const nazwa = reszta.at(-1);
  const k = stan.kontenery[nazwa];
  if (!k) wyjdz(1, `Error: No such object: ${nazwa}`);
  wyjdz(0, format(reszta[reszta.indexOf('--format') + 1], { kontener: k, obraz: k.obraz }));
}
if (polecenie === 'image') {
  const [akcja, ...arg] = reszta;
  if (akcja === 'inspect') {
    const obraz = rozwiaz(arg.at(-1));
    if (!obraz) wyjdz(1, `Error: No such image: ${arg.at(-1)}`);
    wyjdz(0, format(arg[arg.indexOf('--format') + 1], { obraz }));
  }
  if (akcja === 'rm') { for (const t of arg) delete stan.tagi[t]; zapisz(); wyjdz(0); }
  if (akcja === 'prune') wyjdz(0);
  wyjdz(1, 'atrapa: image ' + akcja);
}
if (polecenie === 'tag') {
  const obraz = rozwiaz(reszta[0]);
  if (!obraz) wyjdz(1, 'No such image');
  stan.tagi[reszta[1]] = obraz; zapisz(); wyjdz(0);
}
if (polecenie === 'stop') {
  // Jak docker: zatrzymuje istniejące, za brakujący kod 1.
  let kod = 0;
  for (const n of reszta) { if (stan.kontenery[n]) stan.kontenery[n].dziala = false; else kod = 1; }
  zapisz(); wyjdz(kod);
}
if (polecenie === 'exec') {
  const k = stan.kontenery[reszta[0]];
  if (!k || !k.dziala) wyjdz(1, `container ${reszta[0]} is not running`);
  const tekst = reszta.join(' ');
  const wydanie = path.join(stan.obrazy[k.obraz].korzen, 'wydanie.json');
  if (tekst.includes('/app/wydanie.json')) wyjdz(0, ma(k.obraz, 'TEST_INNY_KOD') ? JSON.stringify({ commit: 'f'.repeat(40) }) : fs.readFileSync(wydanie, 'utf8'));
  // `exec oms test -f <plik>` — plik w kodzie obrazu (katalog wydania, z którego obraz zbudowano).
  if (reszta[1] === 'test' && reszta[2] === '-f') wyjdz(fs.existsSync(path.join(stan.obrazy[k.obraz].korzen, reszta[3])) ? 0 : 1);
  if (tekst.includes('produkcja-pierwszy-start.mjs')) {
    if (process.env.TEST_PIERWSZY_START_BLAD) wyjdz(1, 'PRODUKCJA_LOGIN_SERWISOWY_ODMOWA');
    const db = new DatabaseSync(path.join(process.env.OMS_KATALOG, 'data/oms.sqlite'));
    try { db.prepare("INSERT INTO konta (login) VALUES ('administrator')").run(); } finally { db.close(); }
    wyjdz(0, 'login=administrator\nhaslo=atrapa-haslo-administratora-0123456789');
  }
  if (tekst.includes('/health')) {
    if (k.zepsuty || ma(k.obraz, 'TEST_ZEPSUTY') || ma(k.obraz, 'TEST_WISI')) wyjdz(0, 'HTTP=0 wersja=brak alarmy=?');
    const commit = JSON.parse(fs.readFileSync(wydanie, 'utf8')).commit;
    wyjdz(0, `HTTP=200 wersja=${ma(k.obraz, 'TEST_BEZ_WERSJI') || ma(k.obraz, 'TEST_INNY_KOD') ? 'brak' : commit} alarmy=0`);
  }
  wyjdz(1, 'atrapa: nieznane exec');
}
if (polecenie === 'run') {
  if (process.env.TEST_KOPIA_BLAD) wyjdz(1, 'atrapa: kopia nieudana');
  const mapy = [];
  let i = 0;
  for (; i < reszta.length; i++) {
    const a = reszta[i];
    if (a === '-v') { const m = /^(.*?):(\/[^:]*)(?::(ro|rw))?$/.exec(reszta[++i]); mapy.push([m[2], m[1]]); continue; }
    if (['--user', '--network', '--entrypoint'].includes(a)) { i++; continue; }
    if (a.startsWith('-')) continue;
    break;
  }
  const obraz = rozwiaz(reszta[i]);
  if (!obraz) wyjdz(1, `Unable to find image ${reszta[i]}`);
  const naHost = p => { const m = mapy.filter(([c]) => p === c || p.startsWith(c + '/')).sort((a, b) => b[0].length - a[0].length)[0]; return m ? m[1] + p.slice(m[0].length) : p; };
  const args = reszta.slice(i + 1).map(naHost);
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
  process.stdout.write(r.stdout ?? ''); process.stderr.write(r.stderr ?? '');
  process.exit(r.status ?? 1);
}
if (polecenie === 'builder' || polecenie === 'system') wyjdz(0);
// Dziennik odmowy startu jak z prawdziwego OMS (próba 10.10 na VM): powody „[moduł] ZMIENNA: …”, potem stos.
if (polecenie === 'logs') wyjdz(0, ['Error: OMS nie wystartuje — konfiguracja:', '[rdzen] OMS_SPRZEDAWCA_NIP: niepoprawny NIP (atrapa dziennika)', '[faktury] OMS_SPRZEDAWCA_NIP: niepoprawny NIP (atrapa dziennika)', '    at przygotujModuly (file:///app/src/core/aplikacja.ts:29:27)', '    at main (file:///app/src/main.ts:18:27)', '    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:101:5)', '', 'Node.js v24.21.0'].join('\n'));
wyjdz(1, `atrapa: nieznane ${argv.join(' ')}`);
