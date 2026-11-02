import fs from 'node:fs';
import path from 'node:path';
import { PROG_KOPII_H, type StanKopii } from '../../zdrowie/kopie.ts';

type Historia = { plik: string; data: string; rozmiar: number; wiekH: number; rodzaj: 'baza' | 'pliki' };
type IO = Pick<typeof fs, 'readdirSync' | 'lstatSync' | 'statSync'>;
type Opcje = { katalog?: string; zewnetrzna?: string; teraz?: Date; nadzor?: (() => StanKopii) | null; io?: IO };
type Odczyt = { stan: 'brak' | 'uwaga' | 'odczytano' | 'blad'; opis: string; historia: Historia[] };

function czytaj(katalog: string, teraz: Date, io: IO): Odczyt {
  try {
    const historia: Historia[] = [];
    for (const plik of io.readdirSync(katalog)) {
      const rodzaj = /^oms-\d{4}-\d{2}-\d{2}\.sqlite$/.test(plik) ? 'baza'
        : /^pliki-\d{4}-\d{2}-\d{2}\.tgz$/.test(plik) ? 'pliki' : null;
      if (!rodzaj) continue;
      const stat = io.lstatSync(path.join(katalog, plik));
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      historia.push({ plik, data: stat.mtime.toISOString(), rozmiar: stat.size, wiekH: Math.floor((teraz.getTime() - stat.mtimeMs) / 3600000), rodzaj });
    }
    historia.sort((a, b) => b.data.localeCompare(a.data) || a.plik.localeCompare(b.plik));
    const baza = historia.find(p => p.rodzaj === 'baza');
    if (!baza) return { stan: 'brak', opis: 'Nie znaleziono kopii bazy.', historia };
    if (baza.wiekH >= PROG_KOPII_H) return { stan: 'uwaga', opis: `Najnowszy plik kopii bazy ma ${baza.wiekH} h.`, historia };
    return { stan: 'odczytano', opis: 'Odczytano daty i rozmiary plików. Data pochodzi z czasu modyfikacji pliku.', historia };
  } catch {
    return { stan: 'blad', opis: 'Nie udało się odczytać katalogu lub pliku kopii.', historia: [] };
  }
}

/** Odczyt metadanych, bez uruchamiania ani sprawdzania zawartości kopii. */
export function odczytajKopie({ katalog = '', zewnetrzna = '', teraz = new Date(), nadzor = null, io = fs }: Opcje = {}) {
  const lokalna = katalog ? czytaj(katalog, teraz, io) : {
    stan: 'nie_skonfigurowano' as const, opis: 'Nie skonfigurowano katalogu kopii OMS.', historia: [] as Historia[],
  };
  let zew: { stan: string; opis: string; historia: Historia[] } = {
    stan: 'nie_skonfigurowano', opis: 'Nie ustawiono celu zewnętrznego.', historia: [],
  };
  if (zewnetrzna) {
    const odczyt = czytaj(zewnetrzna, teraz, io);
    zew = odczyt.stan === 'blad' ? odczyt : {
      stan: 'nieustalono', opis: 'Nie ustalono, czy katalog znajduje się na osobnym nośniku.', historia: odczyt.historia,
    };
    if (odczyt.stan !== 'blad' && nadzor && katalog) {
      try {
        // Istniejący health uznaje błąd stat za różne dyski; sprawdzenie poniżej
        // zapobiega przedstawieniu nierozpoznanego urządzenia jako sukcesu.
        const lokalneDev = io.statSync(katalog).dev;
        const zewDev = io.statSync(zewnetrzna).dev;
        if (!Number.isFinite(lokalneDev) || !Number.isFinite(zewDev)) throw new Error('Nieznane urządzenie');
        const stan = nadzor().zewnetrznaStan;
        if (lokalneDev === zewDev || stan === 'ten-sam-dysk') zew = { ...zew, stan: 'uwaga', opis: 'Cel znajduje się na tym samym urządzeniu.' };
        else if (stan === 'brak-nosnika') zew = { ...zew, stan: 'brak', opis: 'Nie wykryto znacznika nośnika.' };
        else if (stan === 'stara-na-nosniku') zew = { ...zew, stan: 'uwaga', opis: 'Nadzór zgłasza brak lub wiek kopii na nośniku.' };
        else if (stan === 'ok') zew = { ...odczyt, opis: 'Odczytano pliki na osobnym urządzeniu; data jest czasem modyfikacji pliku.' };
      } catch { /* Nieznane urządzenie lub niedostępny nadzór nie potwierdza osobnego nośnika. */ }
    }
  }
  return {
    ...lokalna, zewnetrzna: zew,
    zakres: [
      'Kopia bazy obejmuje dane i sekrety zapisane w bazie.',
      'Archiwum plików obejmuje wyłącznie etykiety i proformy.',
      'Konfiguracja serwera i sekrety poza bazą nie są objęte tym zakresem.',
      'Data pliku nie potwierdza sprawności odtwarzania ani spójności kopii.',
    ],
    retencja: null, harmonogram: null,
  };
}
