import fs from 'node:fs';
import path from 'node:path';
import { PROG_UWAGI_KOPII_H } from '../../domena/ostrzezenia.js';

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

// PRZ-122.B16a: próg uwagi (26 h) — jedno źródło z tabelką ostrzeżeń (domena). Alarm zostaje przy 48 h.
export { PROG_UWAGI_KOPII_H };

/**
 * PRZ-122.B16a: jedno miejsce reguły „program wbudowany (faktury tylko w bazie OMS-u) wymaga nadzoru kopii”.
 * W próbie kopii nie wymagamy (bez Dockera OMS działa tylko jako próba).
 */
export function nadzorKopiiWymagany(o: { wbudowany: boolean; proba: boolean }): boolean {
  return o.wbudowany && !o.proba;
}

/** Uwaga /health: program wbudowany bez OMS_KOPIE_KATALOG (nazwa programu z jego opisu). */
export const uwagaBezNadzoruKopii = (nazwa: string): string =>
  `${nazwa} trzyma faktury tylko w bazie, a nadzór kopii jest wyłączony (brak OMS_KOPIE_KATALOG) — kopia bazy musi trafiać poza ten dysk (oms-kopia).`;

export type OstatniaKopia = { plik: string; wiekH: number };
export type StanKopii = { alarmy: string[]; uwagi: string[]; ostatnia: OstatniaKopia | null; katalogDostepny: boolean; zewnetrzna: boolean; zewnetrznaStan: 'nieustawiona' | 'brak-nosnika' | 'ten-sam-dysk' | 'stara-na-nosniku' | 'ok' };

function ocen(opis: string, katalog: string, teraz: Date, alarmy: string[], uwagi?: string[]): { dostepny: boolean; ostatnia: OstatniaKopia | null } {
  let n: ReturnType<typeof najnowsza>;
  try { n = najnowsza(katalog); } catch { alarmy.push(`${opis}: katalog ${katalog} niedostępny`); return { dostepny: false, ostatnia: null }; }
  if (!n) { alarmy.push(`${opis}: brak kopii w ${katalog}`); return { dostepny: true, ostatnia: null }; }
  const wiekH = Math.floor((teraz.getTime() - n.mtimeMs) / 3600_000);
  if (wiekH >= PROG_KOPII_H) alarmy.push(`${opis}: najnowsza ${n.nazwa} ma ${wiekH} h (próg ${PROG_KOPII_H} h)`);
  else if (uwagi && wiekH >= PROG_UWAGI_KOPII_H) uwagi.push(`Ostatnia kopia bazy ma ${wiekH} h — oms-kopia nie zrobił kopii w ostatniej dobie`);
  return { dostepny: true, ostatnia: { plik: n.nazwa, wiekH } };
}

/**
 * Alarmy i uwagi o kopiach; pusta `zewnetrzna` = celu nie ustawiono (uwaga, nie cisza).
 * PRZ-122.B16a: `ostatnia`, `katalogDostepny`, `zewnetrzna` (cel ustawiony) — pola dla panelu, nie dla /health.
 */
export function stanKopii(o: { katalog: string; zewnetrzna: string; teraz: Date; urzadzenie?: (p: string) => number | bigint }): StanKopii {
  const urzadzenie = o.urzadzenie ?? ((p: string) => fs.statSync(p).dev);
  const alarmy: string[] = [];
  const uwagi: string[] = [];
  let zewnetrznaStan: StanKopii['zewnetrznaStan'] = 'ok';
  const lokalna = ocen('kopia bazy', o.katalog, o.teraz, alarmy, uwagi);
  if (!o.zewnetrzna) {
    zewnetrznaStan = 'nieustawiona';
    uwagi.push('kopia poza dyskiem: nieustawiona — awaria dysku serwera zabierze bazę razem z kopiami (OMS_KOPIA_ZEWNETRZNA)');
  } else if (!fs.existsSync(path.join(o.zewnetrzna, ZNACZNIK_NOSNIKA))) {
    zewnetrznaStan = 'brak-nosnika';
    // Niepodłączony pendrive zostawia pusty katalog montowania na dysku serwera.
    alarmy.push(`kopia poza dyskiem: brak nośnika w ${o.zewnetrzna} (brak pliku ${ZNACZNIK_NOSNIKA})`);
  } else if (tenSamDysk(urzadzenie, o.zewnetrzna, o.katalog)) {
    zewnetrznaStan = 'ten-sam-dysk';
    // Znacznik jest, ale katalog leży na tym samym dysku co kopie lokalne: montowanie się nie udało.
    alarmy.push(`kopia poza dyskiem: ${o.zewnetrzna} jest na tym samym dysku co ${o.katalog} — nośnik niezamontowany`);
  } else {
    const liczbaAlarmow = alarmy.length;
    ocen('kopia poza dyskiem', o.zewnetrzna, o.teraz, alarmy);
    if (alarmy.length > liczbaAlarmow) zewnetrznaStan = 'stara-na-nosniku';
  }
  return { alarmy, uwagi, ostatnia: lokalna.ostatnia, katalogDostepny: lokalna.dostepny, zewnetrzna: Boolean(o.zewnetrzna), zewnetrznaStan };
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
