import fs from 'node:fs';
import path from 'node:path';

// PRZ-059: nadzór kopii instalacji klienta. Czyta wyłącznie daty plików w katalogach kopii
// (lokalnym i na nośniku zewnętrznym) — nie zależy od procesu, który kopie robi: martwy kontener
// kopii też kończy się alarmem, bo pliki się starzeją.
export const PROG_KOPII_H = 48;
export const ZNACZNIK_NOSNIKA = '.oms-cel-kopii';
const WZORZEC = /^oms-\d{4}-\d{2}-\d{2}\.sqlite$/;

function najnowsza(katalog: string): { nazwa: string; mtimeMs: number } | null {
  let wynik: { nazwa: string; mtimeMs: number } | null = null;
  for (const nazwa of fs.readdirSync(katalog)) {
    if (!WZORZEC.test(nazwa)) continue;
    const mtimeMs = fs.statSync(path.join(katalog, nazwa)).mtimeMs;
    if (!wynik || mtimeMs > wynik.mtimeMs) wynik = { nazwa, mtimeMs };
  }
  return wynik;
}

function ocen(opis: string, katalog: string, teraz: Date, alarmy: string[]): void {
  let n: ReturnType<typeof najnowsza>;
  try { n = najnowsza(katalog); } catch { alarmy.push(`${opis}: katalog ${katalog} niedostępny`); return; }
  if (!n) { alarmy.push(`${opis}: brak kopii w ${katalog}`); return; }
  const wiekH = Math.floor((teraz.getTime() - n.mtimeMs) / 3600_000);
  if (wiekH >= PROG_KOPII_H) alarmy.push(`${opis}: najnowsza ${n.nazwa} ma ${wiekH} h (próg ${PROG_KOPII_H} h)`);
}

/** Alarmy i uwagi o kopiach; pusta `zewnetrzna` = celu nie ustawiono (uwaga, nie cisza). */
export function stanKopii(o: { katalog: string; zewnetrzna: string; teraz: Date; urzadzenie?: (p: string) => number | bigint }): { alarmy: string[]; uwagi: string[] } {
  const urzadzenie = o.urzadzenie ?? ((p: string) => fs.statSync(p).dev);
  const alarmy: string[] = [];
  const uwagi: string[] = [];
  ocen('kopia bazy', o.katalog, o.teraz, alarmy);
  if (!o.zewnetrzna) {
    uwagi.push('kopia poza dyskiem: nieustawiona — awaria dysku serwera zabierze bazę razem z kopiami (OMS_KOPIA_ZEWNETRZNA)');
  } else if (!fs.existsSync(path.join(o.zewnetrzna, ZNACZNIK_NOSNIKA))) {
    // Niepodłączony pendrive zostawia pusty katalog montowania na dysku serwera.
    alarmy.push(`kopia poza dyskiem: brak nośnika w ${o.zewnetrzna} (brak pliku ${ZNACZNIK_NOSNIKA})`);
  } else if (tenSamDysk(urzadzenie, o.zewnetrzna, o.katalog)) {
    // Znacznik jest, ale katalog leży na tym samym dysku co kopie lokalne: montowanie się nie udało.
    alarmy.push(`kopia poza dyskiem: ${o.zewnetrzna} jest na tym samym dysku co ${o.katalog} — nośnik niezamontowany`);
  } else {
    ocen('kopia poza dyskiem', o.zewnetrzna, o.teraz, alarmy);
  }
  return { alarmy, uwagi };
}

function tenSamDysk(urzadzenie: (p: string) => number | bigint, a: string, b: string): boolean {
  try { return urzadzenie(a) === urzadzenie(b); } catch { return false; }
}

/** Pełny commit z wydanie.json obrazu (paczka klienta); poza obrazem z paczki — null. */
export function wersjaWydania(plik: URL): string | null {
  try {
    const commit = JSON.parse(fs.readFileSync(plik, 'utf8'))?.commit;
    return typeof commit === 'string' && /^[0-9a-f]{40}$/.test(commit) ? commit : null;
  } catch { return null; }
}
