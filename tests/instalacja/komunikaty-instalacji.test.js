// PRZ-093.03: pierwsze minuty obcej firmy. Instalator kończył się ogólnym kodem bez powodu (stary Node,
// zajęty port, zawieszony etap) albo gołym JSON-em bez „co dalej”. Te testy pilnują trzech rzeczy:
// kontroli wersji Node przed czymkolwiek, powodu błędu etapu potomnego bez sekretów i wskazówek po sukcesie.
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WYMAGANY_NODE, sprawdzWersjeNode, powodPotomka, sekretyKatalogu, coDalejLokalnie, coDalejKontener,
} from '../../scripts/instalacja-wspolne.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const katalogi = [];
function katalog() { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'oms-komunikaty-')); katalogi.push(p); return p; }
afterEach(() => { for (const p of katalogi.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });

function zajmijPort(port) {
  return new Promise((resolve, reject) => {
    const serwer = net.createServer();
    serwer.once('error', reject);
    serwer.listen(port, '127.0.0.1', () => resolve(serwer));
  });
}
const zwolnij = serwer => new Promise(resolve => serwer.close(() => resolve()));

describe('kontrola wersji Node przed instalacją', () => {
  it('na starym Node mówi, jakiej wersji trzeba, jaką masz i skąd wziąć nową', () => {
    const komunikat = sprawdzWersjeNode('20.19.2');
    expect(komunikat).toMatch(/^INSTALACJA_NODE_ZA_STARY: /);
    expect(komunikat).toContain(`Node.js ${WYMAGANY_NODE} lub nowszy`);
    expect(komunikat).toContain('masz 20.19.2');
    expect(komunikat).toContain('https://nodejs.org/');
    expect(komunikat).toContain('docs/instalacja-klienta.md');
    expect(komunikat).not.toContain('\n');
    expect(sprawdzWersjeNode('v22.23.2')).toContain('masz 22.23.2');
  });

  it('przepuszcza wymaganą i nowszą wersję', () => {
    expect(sprawdzWersjeNode(`${WYMAGANY_NODE}.0.0`)).toBeNull();
    expect(sprawdzWersjeNode('24.18.0')).toBeNull();
    expect(sprawdzWersjeNode('v26.1.0')).toBeNull();
    expect(sprawdzWersjeNode(process.versions.node)).toBeNull();
  });

  it('wymagana wersja jest tą z package.json (engines), nie osobną liczbą', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.engines.node).toBe(`>=${WYMAGANY_NODE}.0.0`);
  });

  // Kontrola siedzi w instalacja-wspolne.mjs i działa przy jego ewaluacji. ESM najpierw wiąże WSZYSTKIE statyczne
  // importy, więc import 'node:sqlite' (brak w Node 20) albo pliku .ts wywróciłby skrypt, zanim kontrola ruszy.
  it('skrypty instalacji statycznie importują tylko moduły obecne w starym Node i wspólny plik z kontrolą', () => {
    const dozwolone = new Set(['node:fs', 'node:path', 'node:url', 'node:child_process', 'node:http', 'node:crypto', './instalacja-wspolne.mjs']);
    for (const nazwa of ['demo', 'proba', 'kontener', 'otworz', 'przygotuj', 'wspolne']) {
      const tekst = fs.readFileSync(path.join(ROOT, `scripts/instalacja-${nazwa}.mjs`), 'utf8');
      const importy = [...tekst.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map(m => m[1]);
      expect(importy.length, nazwa).toBeGreaterThan(0);
      for (const modul of importy) expect.soft(dozwolone.has(modul), `${nazwa}: statyczny import ${modul}`).toBe(true);
      if (nazwa !== 'wspolne') expect(importy, nazwa).toContain('./instalacja-wspolne.mjs');
    }
    expect(fs.readFileSync(path.join(ROOT, 'scripts/instalacja-wspolne.mjs'), 'utf8')).toMatch(/^wymagajNode\(\);$/m);
  });
});

describe('powód błędu etapu potomnego', () => {
  it('przekroczenie czasu nazywa wprost, z limitem w sekundach', () => {
    const wynik = spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { encoding: 'utf8', timeout: 300 });
    expect(wynik.error?.code).toBe('ETIMEDOUT');
    expect(powodPotomka(wynik, { limitMs: 60_000 })).toMatch(/przekroczono 60 s/);
  });

  it('podaje ostatnie linie stderr potomka, a linii z sekretem nie przenosi', () => {
    const skrypt = [
      "console.error('    at ukryty (plik.js:1:1)')",
      "console.error('haslo=Tajne-Haslo-12345')",
      "console.error('linia z sekretem Sekret-Serwisu-777 w środku')",
      "console.error('INSTALACJA_PROBA_PIERWSZY_START: listen EADDRINUSE: address already in use 127.0.0.1:39999')",
      'process.exit(1)',
    ].join(';');
    const wynik = spawnSync(process.execPath, ['-e', skrypt], { encoding: 'utf8', timeout: 20_000 });
    const powod = powodPotomka(wynik, { limitMs: 60_000, sekrety: ['Sekret-Serwisu-777'] });
    expect(powod).toContain('INSTALACJA_PROBA_PIERWSZY_START: listen EADDRINUSE');
    expect(powod).not.toContain('Tajne-Haslo-12345');
    expect(powod).not.toContain('Sekret-Serwisu-777');
    expect(powod).not.toContain('ukryty');
    expect(powod).not.toContain('\n');
  });

  it('bez komunikatu podaje przynajmniej kod wyjścia', () => {
    const wynik = spawnSync(process.execPath, ['-e', 'process.exit(3)'], { encoding: 'utf8', timeout: 20_000 });
    expect(powodPotomka(wynik, { limitMs: 60_000 })).toMatch(/kod wyjścia 3/);
  });

  it('sekrety katalogu to hasło serwisowe z proba.env i hasło administratora', () => {
    const p = katalog();
    fs.writeFileSync(path.join(p, 'proba.env'), 'OMS_TRYB=proba\nOMS_USER=serwis-proby\nOMS_PASS=haslo-serwisowe-abc\nOMS_KANALY=[]\n');
    fs.writeFileSync(path.join(p, 'administrator-proby.env'), 'login=administrator-proby\nhaslo=haslo-admina-xyz\n');
    expect(sekretyKatalogu(p).sort()).toEqual(['haslo-admina-xyz', 'haslo-serwisowe-abc']);
    expect(sekretyKatalogu(path.join(p, 'brak'))).toEqual([]);
  });

  it('demo przy zajętym porcie pokazuje kod etapu i powód, bez haseł', async () => {
    const port = 39391;
    const serwer = await zajmijPort(port);
    const p = path.join(katalog(), 'demo');
    let wynik;
    try {
      wynik = spawnSync(process.execPath, [path.join(ROOT, 'scripts/instalacja-demo.mjs'), '--katalog', p, '--port', String(port)],
        { cwd: ROOT, encoding: 'utf8', timeout: 90_000 });
    } finally { await zwolnij(serwer); }
    expect(wynik.status).toBe(1);
    expect(wynik.stderr).toMatch(/^INSTALACJA_DEMO_PROBA_ODMOWA: .*EADDRINUSE/m);
    for (const sekret of sekretyKatalogu(p)) expect(wynik.stdout + wynik.stderr).not.toContain(sekret);
    expect(sekretyKatalogu(p).length).toBeGreaterThan(0);
  });

  it('kontener przy zajętym porcie przepuszcza z demo kod RAZEM z powodem', async () => {
    const port = 39392;
    const serwer = await zajmijPort(port);
    const baza = katalog();
    const dane = path.join(baza, 'data'); const konfiguracja = path.join(baza, 'config');
    fs.mkdirSync(dane); fs.mkdirSync(konfiguracja);
    let wynik;
    try {
      wynik = spawnSync(process.execPath, [path.join(ROOT, 'scripts/instalacja-kontener.mjs'), '--port', String(port)], {
        encoding: 'utf8', timeout: 120_000, env: { ...process.env, OMS_KATALOG_DANYCH: dane, OMS_KATALOG_KONFIGURACJI: konfiguracja },
      });
    } finally { await zwolnij(serwer); }
    expect(wynik.status).toBe(1);
    expect(wynik.stderr).toMatch(/^INSTALACJA_DEMO_PROBA_ODMOWA: .*EADDRINUSE/m);
    expect(wynik.stderr).toMatch(/^INSTALACJA_KONTENER_DEMO_ODMOWA/m);
    for (const sekret of sekretyKatalogu(dane)) expect(wynik.stdout + wynik.stderr).not.toContain(sekret);
  });
});

describe('„co dalej” po udanej instalacji', () => {
  it('lokalnie: polecenie otwarcia, adres logowania, plik z hasłem i jak zatrzymać', () => {
    const k = path.join(os.tmpdir(), 'oms demo');
    const tekst = coDalejLokalnie({ katalog: k, port: 39151 }).join('\n');
    expect(tekst).toContain(`instalacja-otworz.mjs --katalog "${k}" --port 39151`);
    expect(tekst).toContain('http://127.0.0.1:39151/login');
    expect(tekst).toContain(path.join(k, 'administrator-proby.env'));
    expect(tekst).toContain('Ctrl+C');
  });

  it('w kontenerze: compose up/down, adres z portem i plik konta w katalogu konfiguracji', () => {
    const tekst = coDalejKontener({ konfiguracja: '/opt/oms/config', port: 3001 }).join('\n');
    expect(tekst).toContain('sudo docker compose up -d');
    expect(tekst).toContain('sudo docker compose down');
    expect(tekst).toContain(':3001/login');
    expect(tekst).toContain(path.join('/opt/oms/config', 'administrator-proby.env'));
  });
});
