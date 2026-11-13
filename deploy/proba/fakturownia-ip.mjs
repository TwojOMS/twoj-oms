// PRZ-119.11a — „stan” piaskownicy: IP konta próbnego Fakturowni wpuszczone w zaporze VM a DNS teraz.
// Wyjątek zapory otwiera adresy Fakturowni (wspólne dla wszystkich kont, za równoważeniem obciążenia AWS) — mogą się
// zmienić. Plik `/etc/oms-proba/fakturownia-ip` zakłada i odświeża root poleceniem z T7; tu wyłącznie ODCZYT
// i jedno zdanie. Zwykły JS (bez TypeScriptu): uruchamia go `nas-proba.sh stan` node'em hosta.
//   node deploy/proba/fakturownia-ip.mjs <plik profilu fakturownia-proba.json>
import fs from 'node:fs';
import dns from 'node:dns';
import { fileURLToPath } from 'node:url';
import { WZOR_DOMENY_FAKTUROWNI } from '../../src/domena/konfiguracja-fakturownia.js';

export const PLIK_IP_FAKTUROWNI = '/etc/oms-proba/fakturownia-ip';

const adresyZPliku = (tresc) => new Set(String(tresc).split(/\s+/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#')));

/** Jedno zdanie (bez nowej linii); nigdy nie rzuca. */
export async function porownajIpFakturowni({
  domena, plikIp = PLIK_IP_FAKTUROWNI,
  czytaj = () => fs.readFileSync(plikIp, 'utf8'),
  resolve4 = (host) => dns.promises.resolve4(host),
}) {
  if (!WZOR_DOMENY_FAKTUROWNI.test(String(domena ?? ''))) return 'Fakturownia: niepoprawna domena w pliku profilu — porównanie IP pominięte.';
  let wZaporze;
  try { wZaporze = adresyZPliku(czytaj()); } catch (e) {
    return e?.code === 'ENOENT'
      ? `Fakturownia: brak pliku ${plikIp} — zapora nie wpuszcza konta próbnego; załóż go poleceniem roota z T7.`
      : `Fakturownia: nie można odczytać ${plikIp} (${e?.code ?? 'błąd'}).`;
  }
  const host = `${domena}.fakturownia.pl`;
  let wDns;
  try { wDns = await resolve4(host); } catch (e) {
    return `Fakturownia: błąd DNS dla ${host} (${e?.code ?? 'błąd'}) — porównania z zaporą nie ma.`;
  }
  const brakujace = [...new Set(wDns)].filter((ip) => !wZaporze.has(ip)).sort();
  if (!brakujace.length) return `Fakturownia: IP zapory zgodne z DNS ${host} (${[...new Set(wDns)].sort().join(', ')}).`;
  return `Fakturownia: DNS ${host} wskazuje ${brakujace.join(', ')}, czego nie ma w ${plikIp} — odśwież poleceniem roota z T7.`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  let domena = '';
  // Treści pliku profilu nie wypisujemy (gdyby ktoś wkleił tam token) — tylko pole `domena`.
  try { domena = JSON.parse(fs.readFileSync(process.argv[2] ?? '', 'utf8'))?.domena ?? ''; } catch { /* zdanie niżej */ }
  console.log(await porownajIpFakturowni({ domena }));
}
