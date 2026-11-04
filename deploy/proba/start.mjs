// Wejście kontenera oms-proba (PRZ-072). Brak bazy = świeże demo: generator (scripts/demo-dane.mjs)
// na dzisiejszy dzień i konto administratora z /konfiguracja/konto.json (login + hash scrypt; hasło
// zna tylko C:/Users/uzytkownik/.oms/proba.json na laptopie). Potem OMS z atrapami integracji (PRZ-076, deploy/proba/atrapy).
// `proba.ps1 reset` zostawia znacznik dane/oms.sqlite.reset-proba i zapisuje deploy/proba/.przeladuj — node --watch
// uruchamia ten plik od nowa, a wykonajZlecenieResetu zakłada świeże demo z zachowaną konfiguracją Allegro Sandbox.
import fs from 'node:fs';

const baza = process.env.OMS_DB_PATH;
if (process.env.OMS_TRYB !== 'proba') throw new Error('Piaskownica startuje wyłącznie z OMS_TRYB=proba');
if (!baza) throw new Error('Brak OMS_DB_PATH');
// Kanały, sprzedawca i podłoga raportu z generatora — JEDNO źródło. Kopia w proba.env rozjechała się
// z zamówieniami przy pierwszej zmianie kanałów demo (14.10: „nieznany sklep OMS: allegro”).
const { ENV_DEMO } = await import('../../scripts/demo-dane.mjs');
for (const [klucz, wartosc] of Object.entries(ENV_DEMO)) process.env[klucz] = wartosc;
// Plik dojeżdża przez wyslij bez odtworzenia kontenera i jego zmiennych z compose.
process.env.OMS_TWOJEFAKTURY ??= 'tak';

async function utworzBaze() {
  // Osierocone -wal/-shm po bazie skasowanej przy resecie — bez nich generator odmówiłby nadpisania.
  for (const p of [`${baza}-wal`, `${baza}-shm`]) fs.rmSync(p, { force: true });
  for (const k of [process.env.OMS_PROFORMY_KATALOG, process.env.OMS_ETYKIETY_KATALOG]) if (k) fs.mkdirSync(k, { recursive: true });
  const { utworzBazeDemo } = await import('../../scripts/demo-dane.mjs');
  const { zalozKonto } = await import('../../src/core/bezpieczenstwo/konta.js');
  const { DatabaseSync } = await import('node:sqlite');
  const t0 = Date.now();
  const dzis = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
  const wynik = await utworzBazeDemo({ baza, dzis, env: process.env });
  const konto = JSON.parse(fs.readFileSync('/konfiguracja/konto.json', 'utf8'));
  const db = new DatabaseSync(baza);
  try { zalozKonto(db, { login: konto.login, imie: konto.imie, rola: 'administrator', admin: true, hashHasla: konto.hash }); }
  finally { db.close(); }
  console.log(`piaskownica: świeże demo na ${dzis} w ${Date.now() - t0} ms — ${JSON.stringify(wynik)}`);
}

const { wykonajZlecenieResetu } = await import('../../src/oms/db/reset-demo.js');
// PRZ-149.01: reset z panelu i `nas-proba.sh reset` zachowują aplikację i konta rzeczywistego Allegro Sandbox z panelu.
const reset = await wykonajZlecenieResetu({ baza, utworzBaze, zachowajSandbox: true });
if (reset) console.log(`piaskownica: reset (zlecił ${reset.zlecenie?.login ?? '?'}), zachowane: ${reset.zachowane.join(', ')}, numeracja: ${reset.numeracja}, Allegro Sandbox: ${JSON.stringify(reset.sandbox)}`);
if (!fs.existsSync(baza)) await utworzBaze();

// PRZ-076: OMS z atrapami inFaktu, VIES, Woo i Allegro (deploy/proba/atrapy) — Faktury i Magazyn mają dane demo,
// a nic nie wychodzi z kontenera. Zamiast src/oms.js, który składa produkcyjne integracje (bez kluczy: puste zakładki).
// Obecność prywatnego pliku jest jawnym wyborem profilu testowego. Bez niego
// działa dotychczasowa piaskownica z atrapami. Demo publiczne nie używa tego wejścia.
let zamknij;
if (fs.existsSync('/konfiguracja/allegro-sandbox.json')) {
  let dane;
  try { dane = JSON.parse(fs.readFileSync('/konfiguracja/allegro-sandbox.json', 'utf8')); }
  catch { throw new Error('Nie można odczytać prywatnej konfiguracji Allegro Sandbox.'); }
  const { przygotujUruchomienieSandbox } = await import('./sandbox-uruchomienie.ts');
  const { openOmsDb } = await import('../../src/oms/db/db.ts');
  const { uruchomAplikacje } = await import('../../src/core/uruchomienie.ts');
  const { sprawdzKonfiguracjeModulow } = await import('../../src/core/aplikacja.ts');
  const { uruchomPulsPollerow } = await import('./atrapy/pollery.mjs');
  const { definicjeKanalow } = await import('../../src/moduly/kanaly/konfiguracja.ts');
  const plan = przygotujUruchomienieSandbox(process.env, dane);
  sprawdzKonfiguracjeModulow(plan.moduly, process.env);
  const db = openOmsDb(baza, { moduly: plan.moduly });
  const zatrzymajPuls = uruchomPulsPollerow({ db, env: process.env, zrodla: definicjeKanalow(process.env).map(d => d.klucz) });
  const wynik = await uruchomAplikacje({ moduly: plan.moduly, env: process.env, db, host: '0.0.0.0', port: Number(process.env.OMS_PORT || 3001), nadpisania: plan.nadpisania(db) });
  zamknij = async () => { zatrzymajPuls(); return wynik.zamknij(); };
  dane = null;
  console.log('Allegro: profil rzeczywistego Sandbox, pozostałe integracje: atrapy.');
} else {
  const { uruchomPiaskownice } = await import('./atrapy/index.mjs');
  ({ zamknij } = await uruchomPiaskownice(process.env));
}
const zakoncz = () => {
  process.removeListener('SIGINT', zakoncz);
  process.removeListener('SIGTERM', zakoncz);
  void zamknij().catch((e) => { console.error(e); process.exitCode = 1; });
};
process.on('SIGINT', zakoncz);
process.on('SIGTERM', zakoncz);
console.log(`OMS piaskownicy na :${process.env.OMS_PORT || 3001} — tryb proba, integracje: atrapy (deploy/proba/atrapy)`);
