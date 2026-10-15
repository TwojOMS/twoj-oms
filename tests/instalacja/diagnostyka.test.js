// PRZ-058: skrypt diagnostyczny klienta (deploy/klient/diagnostyka.sh).
// Wynik ma się nadawać do odesłania mailem: ŻADNA wartość z /opt/oms/config nie może się w nim
// znaleźć, nawet gdy pojawi się w dzienniku kontenera albo w odpowiedzi /health.
// Test wstrzykuje znacznik w każdą wartość konfiguracji, a atrapa dockera wypisuje te wartości
// w dzienniku i w /health — skrypt musi je zamaskować. Mutacja wypisująca wartość daje FAIL.
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SKRYPT = path.join(ROOT, 'deploy/klient/diagnostyka.sh');
const SH = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh';
const REWIZJA = 'a'.repeat(39) + 'b';
const DRZEWO = 'c'.repeat(39) + 'd';
const katalogi = [];
afterEach(() => { for (const k of katalogi.splice(0)) fs.rmSync(k, { recursive: true, force: true }); });

const ukosniki = p => p.replaceAll('\\', '/');

function przygotuj({ bezKopii = false } = {}) {
  const baza = fs.mkdtempSync(path.join(os.tmpdir(), 'oms-diag-'));
  katalogi.push(baza);
  const znacznik = 'ZNACZNIK' + randomBytes(6).toString('hex');
  const oms = path.join(baza, 'opt-oms');
  for (const k of ['config', 'data/etykiety', 'data/proformy', 'backups', 'releases']) fs.mkdirSync(path.join(oms, k), { recursive: true });
  // Znacznik na początku I na końcu: maskowanie samej końcówki albo samego początku też wychodzi.
  const z = rdzen => `${znacznik}${rdzen}${znacznik}`;
  const wartosci = {
    OMS_TRYB: z('proba'),
    OMS_DB_PATH: z('/opt/oms/data/oms.sqlite'),
    OMS_PORT: z('3001'),
    OMS_SPRZEDAWCA_NIP: z('1234563218'),
    OMS_RACHUNEK: z('34109010140000000000000000'),
    OMS_USER: z('serwis-proby'),
    OMS_PASS: z('Q9x_-haslo'),
    OMS_KANALY: z('[]'),
    ALLEGRO_CLIENT_SECRET: z('tajny ze spacja '),
    INFAKT_API_KEY: z('ab$c&d|e*f'),
  };
  // CRLF, cudzysłowy i komentarz — tak wyglądają pliki edytowane ręcznie (także z Windowsa).
  const env = Object.entries(wartosci).map(([k, v], i) => {
    if (k === 'ALLEGRO_CLIENT_SECRET') return `${k}="${v}"`;
    if (k === 'INFAKT_API_KEY') return `${k}='${v}'`;
    return i % 2 ? `${k}=${v}\r` : `${k}=${v}`;
  }).join('\n');
  fs.writeFileSync(path.join(oms, 'config/oms.env'), `# konfiguracja próby\n${env}\n`);
  fs.writeFileSync(path.join(oms, 'config/administrator-proby.env'), `login=${z('administrator-proby')}\nhaslo=${z('Adm1n')}\n`);
  fs.writeFileSync(path.join(oms, 'config/produkcja.env.example'), `OMS_TRYB=produkcja\nOMS_PASS=\nSMTP_PASS=${z('szablon')}\n`);
  // Plik niebędący env (klucz PEM): wiersz z „=” nie może wyjść w sekcji konfiguracji jako „nazwa”.
  fs.writeFileSync(path.join(oms, 'config/klucz.pem'), `-----BEGIN PRIVATE KEY-----\nMIIE+${znacznik}/Qx==\n-----END PRIVATE KEY-----\n`);
  if (!bezKopii) {
    const kopia = path.join(oms, 'backups/oms-2026-10-09.sqlite');
    fs.writeFileSync(kopia, Buffer.alloc(4096, 1));
    const godzinaTemu = new Date(Date.now() - 3 * 3600 * 1000);
    fs.utimesSync(kopia, godzinaTemu, godzinaTemu);
  }
  const wszystkie = [...Object.values(wartosci), z('administrator-proby'), z('Adm1n'), z('szablon')];
  fs.writeFileSync(path.join(baza, 'wartosci.txt'), wszystkie.join('\n') + '\n');
  const docker = path.join(baza, 'docker-atrapa');
  fs.writeFileSync(docker, ATRAPA_DOCKERA, { mode: 0o755 });
  return { baza, oms, znacznik, docker, wynik: path.join(baza, 'wynik.txt') };
}

// Atrapa dockera: odpowiada na polecenia, których używa skrypt diagnostyczny. Dziennik i /health
// celowo zawierają wszystkie wartości konfiguracji oraz dane osobowe i tokeny.
const ATRAPA_DOCKERA = `#!/bin/sh
WARTOSCI="$TEST_BAZA/wartosci.txt"
case "$1" in
  version) echo "29.9.0 (klient 29.9.0)" ;;
  compose) echo "Docker Compose version v5.6.0" ;;
  image) echo "${REWIZJA}" ;;
  inspect)
    for a in "$@"; do last="$a"; done
    case "$*" in
      *revision*) echo "${REWIZJA}" ;;
      *Config.Env*) [ -z "$TEST_BEZ_ENV" ] && [ "$last" = oms ] && while IFS= read -r w; do echo "X=$w"; done < "$WARTOSCI"; echo "PATH=/usr/bin" ;;
      *) echo "kontener=$last obraz=oms:${REWIZJA} id=sha256:1234 stan=running start=2026-10-10T08:00:00Z restarty=0 zdrowie=healthy" ;;
    esac ;;
  exec)
    case "$*" in
      *wydanie.json*) printf '{\\n  "commit": "${REWIZJA}",\\n  "tree": "${DRZEWO}",\\n  "kind": "klient-docker"\\n}\\n' ;;
      *health*) printf 'HTTP 200 ok=false alarmy=["kanał x: %s"] uwagi=[]\\n' "$(sed -n 7p "$WARTOSCI")" ;;
      *) echo "nieznane exec" ;;
    esac ;;
  logs)
    echo "OMS na :3001"
    while IFS= read -r w; do echo "blad konfiguracji: wartosc=$w koniec"; done < "$WARTOSCI"
    echo "zamowienie od jan.kowalski@example.com tel +48 500 600 700 nip 5252525252"
    echo "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.dGFqbnk.c2Vrcmv0"
    echo '{"password":"plain-secret-xyz","client_secret":"cs-123456"}'
    echo "refresh_token=rt-9988776655 oraz token tK7aQ2mZ9xR4vB8nL3pW6yH1cJ5dF0gSqE" ;;
  system) echo "Images 1 2.1GB" ;;
  ps) echo "oms Up 2 hours (healthy)" ;;
  *) echo "atrapa: nieznane $1" >&2; exit 1 ;;
esac
`;

function uruchom(k, extra = {}) {
  return spawnSync(SH, [ukosniki(SKRYPT)], {
    encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, OMS_KATALOG: ukosniki(k.oms), OMS_DOCKER_BIN: ukosniki(k.docker), OMS_DIAG_WYJSCIE: ukosniki(k.wynik), TEST_BAZA: ukosniki(k.baza), ...extra },
  });
}

describe('diagnostyka klienta PRZ-058', () => {
  it('zbiera wersję, kontenery, health, dysk, kopię i dziennik — bez żadnej wartości konfiguracji', () => {
    const k = przygotuj();
    const r = uruchom(k);
    expect(r.status, r.stderr).toBe(0);
    const tekst = fs.readFileSync(k.wynik, 'utf8');
    // Sekrety: ani znacznika, ani fragmentu żadnej wartości z konfiguracji (także z cudzysłowami i CRLF).
    expect(tekst).not.toContain(k.znacznik);
    expect(`${r.stdout}${r.stderr}`).not.toContain(k.znacznik);
    // Dane osobowe i tokeny z dziennika.
    for (const zakazane of ['Q9x_-haslo', 'tajny ze spacja', 'ab$c&d|e*f', 'Adm1n', 'MIIE+', 'jan.kowalski@example.com', '500 600 700', '5252525252', 'eyJhbGciOiJIUzI1NiJ9', 'plain-secret-xyz', 'cs-123456', 'rt-9988776655', 'tK7aQ2mZ9xR4vB8nL3pW6yH1cJ5dF0gSqE']) {
      expect(tekst).not.toContain(zakazane);
    }
    // Treść użyteczna — pusty plik też byłby „bez sekretów”.
    for (const sekcja of ['== System ==', '== Docker ==', '== Wersja OMS ==', '== Kontenery ==', '== Health ==', '== Dysk ==', '== Kopie ==', '== Konfiguracja ==', '== Dziennik oms ==', '== Dziennik oms-kopia ==']) {
      expect(tekst).toContain(sekcja);
    }
    expect(tekst).toContain(`commit: ${REWIZJA}`);
    expect(tekst).toContain(`tree: ${DRZEWO}`);
    expect(tekst).toContain(`etykieta revision: ${REWIZJA}`);
    expect(tekst).toMatch(/architektura: \S+/);
    expect(tekst).toContain('29.9.0');
    expect(tekst).toContain('stan=running');
    expect(tekst).toContain('HTTP 200 ok=false');
    expect(tekst).toMatch(/ostatnia kopia: oms-2026-10-09\.sqlite, 4096 B, wiek 3 h/);
    expect(tekst).toContain('OMS_PASS');
    expect(tekst).toContain('OMS na :3001');
    expect(tekst).toContain('[email]');
    expect(r.stdout).toContain(k.wynik.replaceAll('\\', '/'));
  });

  it('zgłasza brak kopii i brak pliku konfiguracji zamiast milczeć', () => {
    const k = przygotuj({ bezKopii: true });
    fs.rmSync(path.join(k.oms, 'config/oms.env'));
    const r = uruchom(k);
    expect(r.status, r.stderr).toBe(0);
    const tekst = fs.readFileSync(k.wynik, 'utf8');
    expect(tekst).toContain('BRAK KOPII');
    expect(tekst).toContain('BRAK oms.env');
    expect(tekst).not.toContain(k.znacznik);
  });

  it('PRZ-059: alarm kopii starszej niż 48 h (lokalnej i na nośniku), brak nośnika, cel nieustawiony, $ w konfiguracji, aktualizacja w toku', () => {
    const k = przygotuj();
    const stara = path.join(k.oms, 'backups/oms-2026-10-09.sqlite');
    const t49 = new Date(Date.now() - 49 * 3600 * 1000); fs.utimesSync(stara, t49, t49);
    const bez = fs.readFileSync((uruchom(k), k.wynik), 'utf8');
    expect(bez).toContain('ALARM: ostatnia kopia ma 49 h (próg 48 h)');
    expect(bez).toContain('kopia poza dyskiem: NIEUSTAWIONA');
    // Cel ustawiony, nośnik niepodłączony (pusty katalog montowania).
    fs.writeFileSync(path.join(k.oms, 'config/kopia.env'), 'OMS_KOPIA_ZEWNETRZNA=/opt/oms/kopia-zewnetrzna/nosnik\r\n');
    const nosnik = path.join(k.oms, 'kopia-zewnetrzna/nosnik'); fs.mkdirSync(nosnik, { recursive: true });
    fs.rmSync(k.wynik);
    const brak = fs.readFileSync((uruchom(k), k.wynik), 'utf8');
    expect(brak).toContain('kopia poza dyskiem: /opt/oms/kopia-zewnetrzna/nosnik');
    expect(brak).toContain('ALARM: kopia poza dyskiem — brak nośnika');
    // Nośnik z kopią sprzed 50 h; świeża kopia lokalna.
    fs.writeFileSync(path.join(nosnik, '.oms-cel-kopii'), '');
    const naNosniku = path.join(nosnik, 'oms-2026-10-08.sqlite'); fs.writeFileSync(naNosniku, Buffer.alloc(2048, 1));
    const t50 = new Date(Date.now() - 50 * 3600 * 1000); fs.utimesSync(naNosniku, t50, t50);
    fs.utimesSync(stara, new Date(), new Date());
    fs.appendFileSync(path.join(k.oms, 'config/oms.env'), 'SMTP_PASS=ab$cd\n');
    fs.mkdirSync(path.join(k.oms, 'update-state/blokada'), { recursive: true });
    fs.writeFileSync(path.join(k.oms, 'update-state/blokada/stan'), 'operacja=20261010-120000-ab12\netap=zatrzymane\npid=1\n');
    fs.writeFileSync(path.join(k.oms, 'update-state/biezace'), 'oms-aaaaaaaaaaaa\n');
    fs.rmSync(k.wynik);
    const t = fs.readFileSync((uruchom(k), k.wynik), 'utf8');
    expect(t).not.toContain('ALARM: ostatnia kopia');
    expect(t).toContain('ALARM: kopia poza dyskiem ma 50 h (próg 48 h)');
    expect(t).toContain('UWAGA: oms.env: SMTP_PASS zawiera $');
    expect(t).not.toContain('ab$cd');
    expect(t).not.toMatch(/INFAKT_API_KEY zawiera/);
    expect(t).toContain('bieżące wydanie: oms-aaaaaaaaaaaa');
    expect(t).toContain('OPERACJA AKTUALIZACJI W TOKU');
    expect(t).toContain('etap=zatrzymane');
    expect(t).not.toContain(k.znacznik);
  });

  it('maskuje wartości z samych plików konfiguracji (cudzysłowy, CRLF), gdy środowisko kontenera jest niedostępne', () => {
    const k = przygotuj();
    const r = uruchom(k, { TEST_BEZ_ENV: '1' });
    expect(r.status, r.stderr).toBe(0);
    const tekst = fs.readFileSync(k.wynik, 'utf8');
    expect(tekst).not.toContain(k.znacznik);
    expect(tekst).toContain('== Dziennik oms ==');
  });

  it('odmawia nadpisania istniejącego pliku wyniku', () => {
    const k = przygotuj();
    fs.writeFileSync(k.wynik, 'stary raport');
    const r = uruchom(k);
    expect(r.status).not.toBe(0);
    expect(fs.readFileSync(k.wynik, 'utf8')).toBe('stary raport');
  });
});
