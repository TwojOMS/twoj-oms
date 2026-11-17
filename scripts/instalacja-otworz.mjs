#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { PLIKI_INSTALACJI, envEtapu, odczytajEnv, opcje, oczyscPowod, sciezkaKlucza, sekretyKatalogu, zapewnijKlucz } from './instalacja-wspolne.mjs';
// Dynamicznie, PO kontroli wersji z instalacja-wspolne.mjs (PRZ-093.03) — statyczny import .ts wywraca stary Node bez słowa.
const { uruchomOms } = await import('../src/main.ts');
let sekrety = [];
async function main() {
  const { katalog, port } = opcje(process.argv.slice(2));
  const plikKlucza = sciezkaKlucza(katalog);
  sekrety = sekretyKatalogu(katalog, plikKlucza);
  const proba = odczytajEnv(path.join(katalog, PLIKI_INSTALACJI.proba));
  if (!fs.existsSync(path.join(katalog, PLIKI_INSTALACJI.znacznik))
    || !fs.existsSync(path.join(katalog, PLIKI_INSTALACJI.baza))
    || proba.OMS_TRYB !== 'proba' || proba.OMS_KANALY !== '[]' || proba.OMS_PORT !== String(port)
    || path.resolve(proba.OMS_DB_PATH ?? '') !== path.join(katalog, PLIKI_INSTALACJI.baza)
    || path.resolve(proba.OMS_PROFORMY_KATALOG ?? '') !== path.join(katalog, 'proformy')
    || path.resolve(proba.OMS_ETYKIETY_KATALOG ?? '') !== path.join(katalog, 'etykiety')) {
    throw new Error('INSTALACJA_NIEZGODNY_KATALOG');
  }
  // PRZ-182: katalog próby sprzed szyfrowania nie ma pliku klucza — `klucz-zapewnij` tworzy go tylko wtedy, gdy
  // baza nie ma szyfrogramów; istniejący plik jest wyłącznie sprawdzany (pusty albo ucięty = odmowa).
  await zapewnijKlucz(plikKlucza, path.join(katalog, PLIKI_INSTALACJI.baza));
  const env = await envEtapu(katalog);
  sekrety = [env.OMS_PASS, env.OMS_KLUCZ_SEKRETOW];
  const { zamknij } = await uruchomOms(env, '127.0.0.1');
  console.log(`OMS próba: http://127.0.0.1:${port}/login`);
  console.log(`Login i hasło: ${path.join(katalog, PLIKI_INSTALACJI.daneAdmina)}. Zatrzymanie: Ctrl+C.`);
  const stop = () => {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    void zamknij().catch(() => { console.error('INSTALACJA_ZAMKNIECIE_ODMOWA'); process.exitCode = 1; });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
// PRZ-093.03: kod zostaje, dochodzi powód (zajęty port, brak pliku próby, niezgodny katalog).
main().catch((e) => {
  console.error(`INSTALACJA_OTWARCIE_ODMOWA: ${oczyscPowod(e instanceof Error ? e.message : e, sekrety)}`);
  process.exitCode = 1;
});
