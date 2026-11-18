#!/usr/bin/env node
// Pierwsze uruchomienie OMS w kontenerze: `sudo docker compose run --rm instalacja`.
// NIE generuje niczego sam — uruchamia istniejące instalacja-demo.mjs (przygotowanie, próba,
// pierwszy administrator, trzy zamówienia DEMO) na katalogu danych, a potem przenosi pliki
// konfiguracji i dane konta do katalogu konfiguracji (/opt/oms/config), skąd czyta je compose.
// Sekrety nie trafiają na ekran: wypisujemy tylko kody INSTALACJA_* i ścieżki plików.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  PLIKI_INSTALACJI,
  powodPotomka,
  sekretyKatalogu,
  oczyscPowod,
  coDalejKontener,
  kluczZPlikuInstalacji,
  ZMIENNA_PLIKU_KLUCZA,
} from './instalacja-wspolne.mjs';

const LIMIT_DEMO_MS = 600_000;
// Poza PLIKI_KONFIGURACJI: istniejący klucz nie blokuje instalacji, a instalator go nie przenosi ani nie kasuje.
export const PLIK_KLUCZA = PLIKI_INSTALACJI.klucz;

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
  try {
    stat = fs.statSync(katalog);
  } catch {
    throw Error('INSTALACJA_KONTENER_BRAK_KATALOGU');
  }
  if (!stat.isDirectory()) throw Error('INSTALACJA_KONTENER_BRAK_KATALOGU');
  try {
    fs.accessSync(katalog, fs.constants.W_OK);
  } catch {
    throw Error('INSTALACJA_KONTENER_BRAK_ZAPISU');
  }
}

function przenies(zrodlo, cel) {
  const tresc = fs.readFileSync(zrodlo);
  fs.writeFileSync(cel, tresc, { mode: 0o600, flag: 'wx' });
  if (!fs.readFileSync(cel).equals(tresc)) throw Error('INSTALACJA_KONTENER_PRZENIESIENIE_ODMOWA');
  // Sekret ma żyć w jednym miejscu: kopia w katalogu danych trafiałaby do kopii zapasowych.
  fs.unlinkSync(zrodlo);
}

// Tryb 600 jak oms.env. Plik założony przez instalator należy do UID procesu (10001 w obrazie); plik
// przyniesiony z menedżera haseł — gdy należy do nas, poprawiamy tryb, gdy nie — mówimy, co zrobić.
function trybKlucza(plik) {
  if (process.platform === 'win32') return null;
  const stat = fs.statSync(plik);
  if ((stat.mode & 0o077) === 0) return null;
  try {
    fs.chmodSync(plik, 0o600);
    return null;
  } catch {
    return `UWAGA: plik klucza ${plik} jest czytelny dla innych użytkowników — sudo chown 10001:10001 ${plik}; sudo chmod 600 ${plik}`;
  }
}

async function main() {
  const dane = path.resolve(process.env.OMS_KATALOG_DANYCH || '/opt/oms/data');
  const konfiguracja = path.resolve(process.env.OMS_KATALOG_KONFIGURACJI || '/opt/oms/config');
  const p = port(process.argv.slice(2));
  katalogDoZapisu(dane);
  katalogDoZapisu(konfiguracja);
  const cele = Object.values(PLIKI_KONFIGURACJI).map((nazwa) => path.join(konfiguracja, nazwa));
  if (cele.some((plik) => fs.existsSync(plik))) throw Error('INSTALACJA_ODMOWA_NADPISANIA');
  if (fs.readdirSync(dane).length) throw Error('INSTALACJA_ODMOWA_NADPISANIA');
  // Klucz poświadczeń od razu w katalogu konfiguracji — nigdy w katalogu danych (ten trafia do kopii).
  // Istniejący klucz.env (ponowienie albo odtwarzanie z kluczem z menedżera haseł) nie jest powodem odmowy:
  // jest sprawdzany i używany, nigdy nadpisywany. Zły plik = odmowa, zanim cokolwiek powstanie.
  const plikKlucza = path.join(konfiguracja, PLIK_KLUCZA);
  if (fs.existsSync(plikKlucza)) await kluczZPlikuInstalacji(plikKlucza);

  const demo = fileURLToPath(new URL('./instalacja-demo.mjs', import.meta.url));
  const wynik = spawnSync(process.execPath, [demo, '--katalog', dane, '--port', String(p)], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { [ZMIENNA_PLIKU_KLUCZA]: plikKlucza },
    encoding: 'utf8',
    timeout: LIMIT_DEMO_MS,
  });
  if (wynik.status !== 0) {
    // Z demo przechodzą linie „KOD” i „KOD: powód” (dawniej tylko goły kod — powód ginął).
    // Hasła z katalogu danych i klucz odfiltrowane: linia z sekretem nie przechodzi wcale.
    const sekrety = sekretyKatalogu(dane, plikKlucza);
    const kody = String(wynik.stderr ?? '')
      .split(/\r?\n/)
      .filter(
        (linia) => /^INSTALACJA_[A-Z0-9_]+(: .*)?$/.test(linia) && !sekrety.some((sekret) => linia.includes(sekret)),
      );
    for (const kod of kody) console.error(oczyscPowod(kod, sekrety));
    // Bez linii od demo (limit czasu, awaria procesu) powód dopisuje sam kontener.
    throw Error(
      kody.length && !wynik.error
        ? 'INSTALACJA_KONTENER_DEMO_ODMOWA'
        : `INSTALACJA_KONTENER_DEMO_ODMOWA: ${powodPotomka(wynik, { limitMs: LIMIT_DEMO_MS, sekrety })}`,
    );
  }
  przenies(path.join(dane, PLIKI_INSTALACJI.proba), path.join(konfiguracja, PLIKI_KONFIGURACJI.env));
  przenies(path.join(dane, PLIKI_INSTALACJI.daneAdmina), path.join(konfiguracja, PLIKI_KONFIGURACJI.daneAdmina));
  przenies(path.join(dane, PLIKI_INSTALACJI.produkcja), path.join(konfiguracja, PLIKI_KONFIGURACJI.produkcja));
  const { id: idKlucza } = await kluczZPlikuInstalacji(plikKlucza);
  const uwaga = trybKlucza(plikKlucza);
  for (const linia of coDalejKontener({ konfiguracja, port: p, klucz: plikKlucza, idKlucza })) console.log(linia);
  if (uwaga) console.log(uwaga);
  console.log(
    JSON.stringify({
      status: 'instalacja-zakonczona',
      konfiguracja: path.join(konfiguracja, PLIKI_KONFIGURACJI.env),
      kontoAdministratora: path.join(konfiguracja, PLIKI_KONFIGURACJI.daneAdmina),
      kluczPoswiadczen: plikKlucza,
      idKlucza,
      dane,
      zamowieniaDemo: 3,
      integracje: 'niepodłączone',
    }),
  );
}

main().catch((e) => {
  // Kontener nie trzyma haseł w pamięci (przenosi pliki, błąd fs podaje tylko ścieżkę; z klucza bierze tylko id).
  console.error(
    e instanceof Error && /^INSTALACJA_/.test(e.message)
      ? e.message
      : `INSTALACJA_KONTENER_ODMOWA: ${oczyscPowod(e instanceof Error ? e.message : e)}`,
  );
  process.exitCode = 1;
});
