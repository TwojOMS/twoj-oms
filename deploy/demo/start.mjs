// Wejście kontenera oms-demo (PRZ-075). Brak bazy = świeże demo: generator (scripts/demo-dane.mjs) na dzisiejszy
// dzień, konto gościa z OMS_DEMO_LOGIN/OMS_DEMO_HASLO (jawne — ekran logowania je pokazuje; rola Sprzedaż: bez
// Ustawień i Finansów) i konto administratora z /konfiguracja/konto.json (hasło zna tylko C:/Users/uzytkownik/.oms/demo.json).
//
// Reset: co DEMO_RESET_CO_MIN minut (domyślnie 60, o pełnych godzinach czasu polskiego; PRZ-079). Od PRZ-083 bez
// restartu kontenera: następna baza powstaje w tle przed terminem, w terminie proces podmienia pliki i składa panel
// od nowa (cykl.mjs). Do PRZ-083 kasował bazę i kończył się kodem 0 — 46 s przerwy (pomiar 15.10). Ten tor zostaje
// awaryjnie, gdy następna baza nie powstanie: wtedy restart: unless-stopped podnosi kontener, a ten plik zakłada demo.
// Bez harmonogramu Synology i bez sudo — kontener resetuje się sam.
import fs from 'node:fs';

const baza = process.env.OMS_DB_PATH;
if (process.env.OMS_TRYB !== 'proba') throw new Error('Demo startuje wyłącznie z OMS_TRYB=proba');
if (!baza) throw new Error('Brak OMS_DB_PATH');
if (!process.env.OMS_DEMO_LOGIN || !process.env.OMS_DEMO_HASLO) throw new Error('Demo wymaga OMS_DEMO_LOGIN i OMS_DEMO_HASLO');
// Bezpiecznik izolacji: Docker na DSM puszcza z sieci internal ruch do usług samego NAS-a; odcinają go dopiero
// reguły deploy/demo/nas-izolacja.sh, które nie przeżywają restartu NAS-a. Gdy którykolwiek cel odpowie —
// odmowa startu (kontener restartuje się w kółko, tunel daje 502), zamiast publicznego demo obok produkcji.
const { wymagajIzolacji } = await import('./sonda.mjs');
const cele = (process.env.DEMO_SONDA_CELE ?? '').split(',').map((c) => c.trim()).filter(Boolean);
console.log(`demo: izolacja sprawdzona — ${await wymagajIzolacji(cele)} celów nieosiągalnych`);
// Kanały, sprzedawca i podłoga raportu z generatora — jedno źródło, jak w piaskownicy (deploy/proba/start.mjs).
const { ENV_DEMO } = await import('../../scripts/demo-dane.mjs');
for (const [klucz, wartosc] of Object.entries(ENV_DEMO)) process.env[klucz] = wartosc;
const { zalozBazeDemo, usunNastepna, podmienNaNastepna, przygotujWTle } = await import('./baza.mjs');

const plikiBazy = [baza, `${baza}-wal`, `${baza}-shm`];
const dzisWarszawa = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
// Następna baza z poprzedniego życia kontenera (przerwany generator albo restart przed podmianą) — do kosza.
usunNastepna(baza);

if (!fs.existsSync(baza)) {
  const t0 = Date.now();
  const dzis = dzisWarszawa();
  // DEMO_KONTO_ADMINA tylko dla testu (tests/instalacja/demo-wydanie.test.js); w kontenerze montowany plik.
  const kontoAdmina = JSON.parse(fs.readFileSync(process.env.DEMO_KONTO_ADMINA || '/konfiguracja/konto.json', 'utf8'));
  const wynik = await zalozBazeDemo({ baza, dzis, env: process.env, kontoAdmina });
  console.log(`demo: świeże dane na ${dzis} w ${Date.now() - t0} ms — ${JSON.stringify(wynik)}`);
}

// PRZ-081: wydanie (nas-demo.sh zbuduj) zakłada bazę NOWYM obrazem w osobnym kontenerze bez sieci, zanim podmieni
// działający — gość od razu ma dane z generatora tego commita, a generator nie wydłuża przerwy. Tu taki przebieg się
// kończy: baza gotowa, panelu nie stawiamy.
if (process.env.DEMO_TYLKO_BAZA === '1') {
  console.log(`demo: baza gotowa w ${baza} (DEMO_TYLKO_BAZA) — panel wstanie w kontenerze po podmianie`);
  process.exit(0);
}

const { msDoResetu, MINUTY_RESETU_DOMYSLNIE } = await import('./reset.mjs');
const { cyklResetu } = await import('./cykl.mjs');
const co = process.env.DEMO_RESET_CO_MIN ? Number(process.env.DEMO_RESET_CO_MIN) : MINUTY_RESETU_DOMYSLNIE;
// demo.env z PRZ-075 na NAS-ie ma jeszcze DEMO_RESET_O=03:00 (wydanie nie przepisuje konfiguracji) — nie steruje już niczym.
if (process.env.DEMO_RESET_O) console.log(`demo: DEMO_RESET_O=${process.env.DEMO_RESET_O} pomijane od PRZ-079 — reset co DEMO_RESET_CO_MIN`);
console.log(`demo: reset co ${co} min (Europe/Warsaw)`);

// PRZ-079: OMS z atrapami integracji piaskownicy (deploy/proba/atrapy, PRZ-076) — Faktury i Magazyn mają dane demo,
// a „Wystaw fakturę”, „Wyślij do KSeF”, „Synchronizuj” działają na atrapie. Zamiast src/oms.js, który składa
// produkcyjne integracje (bez kluczy: puste zakładki). Sieci kontener i tak nie ma (izolacja wyżej).
const { uruchomPiaskownice } = await import('../proba/atrapy/index.mjs');
const przerwij = new AbortController();
const cykl = cyklResetu({
  env: process.env,
  msDo: (teraz) => msDoResetu(teraz, co),
  uruchom: (env) => uruchomPiaskownice(env),
  przygotuj: (dzis) => przygotujWTle({ dzis, env: process.env, signal: przerwij.signal }),
  sprawdzIzolacje: () => wymagajIzolacji(cele),
  podmien: (dzis) => podmienNaNastepna({ baza, dzis, env: process.env }),
  usunBaze: () => { for (const p of plikiBazy) fs.rmSync(p, { force: true }); },
  wyjdz: (kod) => process.exit(kod),
});
await cykl.start();
const zakoncz = () => {
  process.removeListener('SIGINT', zakoncz);
  process.removeListener('SIGTERM', zakoncz);
  cykl.zatrzymaj();
  przerwij.abort();
  void cykl.zamknij().catch((e) => { console.error(e); process.exitCode = 1; });
};
process.on('SIGINT', zakoncz);
process.on('SIGTERM', zakoncz);
console.log(`OMS demo na :${process.env.OMS_PORT || 3001} — tryb proba, integracje: atrapy (deploy/proba/atrapy)`);
