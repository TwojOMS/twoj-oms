#!/usr/bin/env node
// Pierwsze uruchomienie OMS w kontenerze (PRZ-058): `sudo docker compose run --rm instalacja`.
// NIE generuje niczego sam — uruchamia istniejące instalacja-demo.mjs (przygotowanie, próba,
// pierwszy administrator, trzy zamówienia DEMO) na katalogu danych, a potem przenosi pliki
// konfiguracji i dane konta do katalogu konfiguracji (/opt/oms/config), skąd czyta je compose.
// Sekrety nie trafiają na ekran: wypisujemy tylko kody INSTALACJA_* i ścieżki plików.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PLIKI_INSTALACJI, powodPotomka, sekretyKatalogu, oczyscPowod, coDalejKontener } from './instalacja-wspolne.mjs';

const LIMIT_DEMO_MS = 600_000;

export const PLIKI_KONFIGURACJI = Object.freeze({
  env: 'oms.env',
  daneAdmina: PLIKI_INSTALACJI.daneAdmina,
  produkcja: PLIKI_INSTALACJI.produkcja,
});

function port(argv) {
  if (argv.length === 0) return 3001;
  if (argv.length !== 2 || argv[0] !== '--port') throw Error('INSTALACJA_KONTENER_UZYCIE');
  const wynik = Number(argv[1]);
  if (!Number.isInteger(wynik) || wynik < 1024 || wynik > 65535) throw Error('INSTALACJA_KONTENER_UZYCIE');
  return wynik;
}

function katalogDoZapisu(katalog) {
  if (!path.isAbsolute(katalog)) throw Error('INSTALACJA_KONTENER_KATALOG_ODMOWA');
  let stat;
  try { stat = fs.statSync(katalog); } catch { throw Error('INSTALACJA_KONTENER_BRAK_KATALOGU'); }
  if (!stat.isDirectory()) throw Error('INSTALACJA_KONTENER_BRAK_KATALOGU');
  try { fs.accessSync(katalog, fs.constants.W_OK); } catch { throw Error('INSTALACJA_KONTENER_BRAK_ZAPISU'); }
}

function przenies(zrodlo, cel) {
  const tresc = fs.readFileSync(zrodlo);
  fs.writeFileSync(cel, tresc, { mode: 0o600, flag: 'wx' });
  if (!fs.readFileSync(cel).equals(tresc)) throw Error('INSTALACJA_KONTENER_PRZENIESIENIE_ODMOWA');
  // Sekret ma żyć w jednym miejscu: kopia w katalogu danych trafiałaby do kopii zapasowych.
  fs.unlinkSync(zrodlo);
}

function main() {
  const dane = path.resolve(process.env.OMS_KATALOG_DANYCH || '/opt/oms/data');
  const konfiguracja = path.resolve(process.env.OMS_KATALOG_KONFIGURACJI || '/opt/oms/config');
  const p = port(process.argv.slice(2));
  katalogDoZapisu(dane);
  katalogDoZapisu(konfiguracja);
  const cele = Object.values(PLIKI_KONFIGURACJI).map(nazwa => path.join(konfiguracja, nazwa));
  if (cele.some(plik => fs.existsSync(plik))) throw Error('INSTALACJA_ODMOWA_NADPISANIA');
  if (fs.readdirSync(dane).length) throw Error('INSTALACJA_ODMOWA_NADPISANIA');

  const demo = fileURLToPath(new URL('./instalacja-demo.mjs', import.meta.url));
  const wynik = spawnSync(process.execPath, [demo, '--katalog', dane, '--port', String(p)], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), env: {}, encoding: 'utf8', timeout: LIMIT_DEMO_MS,
  });
  if (wynik.status !== 0) {
    // PRZ-093.03: z demo przechodzą linie „KOD” i „KOD: powód” (dawniej tylko goły kod — powód ginął).
    // Hasła z katalogu danych odfiltrowane: linia z sekretem nie przechodzi wcale.
    const sekrety = sekretyKatalogu(dane);
    const kody = String(wynik.stderr ?? '').split(/\r?\n/)
      .filter(linia => /^INSTALACJA_[A-Z0-9_]+(: .*)?$/.test(linia) && !sekrety.some(sekret => linia.includes(sekret)));
    for (const kod of kody) console.error(oczyscPowod(kod, sekrety));
    // Bez linii od demo (limit czasu, awaria procesu) powód dopisuje sam kontener.
    throw Error(kody.length && !wynik.error ? 'INSTALACJA_KONTENER_DEMO_ODMOWA'
      : `INSTALACJA_KONTENER_DEMO_ODMOWA: ${powodPotomka(wynik, { limitMs: LIMIT_DEMO_MS, sekrety })}`);
  }
  przenies(path.join(dane, PLIKI_INSTALACJI.proba), path.join(konfiguracja, PLIKI_KONFIGURACJI.env));
  przenies(path.join(dane, PLIKI_INSTALACJI.daneAdmina), path.join(konfiguracja, PLIKI_KONFIGURACJI.daneAdmina));
  przenies(path.join(dane, PLIKI_INSTALACJI.produkcja), path.join(konfiguracja, PLIKI_KONFIGURACJI.produkcja));
  for (const linia of coDalejKontener({ konfiguracja, port: p })) console.log(linia);
  console.log(JSON.stringify({
    status: 'instalacja-zakonczona',
    konfiguracja: path.join(konfiguracja, PLIKI_KONFIGURACJI.env),
    kontoAdministratora: path.join(konfiguracja, PLIKI_KONFIGURACJI.daneAdmina),
    dane,
    zamowieniaDemo: 3,
    integracje: 'niepodłączone',
  }));
}

try { main(); } catch (e) {
  // Kontener nie trzyma haseł w pamięci (przenosi pliki, błąd fs podaje tylko ścieżkę).
  console.error(e instanceof Error && /^INSTALACJA_/.test(e.message) ? e.message
    : `INSTALACJA_KONTENER_ODMOWA: ${oczyscPowod(e instanceof Error ? e.message : e)}`);
  process.exitCode = 1;
}
