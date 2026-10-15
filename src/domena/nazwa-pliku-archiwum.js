// Nazwy plikow i katalogow archiwum faktur na NAS-ie — WSPOLNE dla archiwum kosztow
// (services/archiwum-kosztow.js: `Kosztowe <rok>/<Miesiac>/RRRR-MM-DD_SPRZEDAWCA_numer`)
// i archiwum sprzedazy (services/archiwum-sprzedazy.js: `<rok>/<Miesiac>/RRRR-MM-DD_numer`).
//
// ⚠️ NAZWY MIESIECY BEZ POLSKICH ZNAKOW — tak wygladaja katalogi, ktore juz istnieja na NAS-ie
// (udzial sieciowy biura: FAKTURY\2026\Sierpien, ...\Kosztowe 2026\Lipiec). Poprawienie ich „na
// ladniejsze" zalozyloby DRUGI komplet katalogow obok pierwszego, bez ani jednego bledu.
export const MIESIACE_KATALOGOW = ['Styczen', 'Luty', 'Marzec', 'Kwiecien', 'Maj', 'Czerwiec',
  'Lipiec', 'Sierpien', 'Wrzesien', 'Pazdziernik', 'Listopad', 'Grudzien'];

// Nazwa trafia do NAZWY PLIKU, wiec musi przezyc system plikow Windows i SMB. Ukosnik
// w numerze faktury (12/08/2026) zalozylby podkatalogi — to nie jest kosmetyka.
export const doNazwyPliku = (s) => String(s ?? '')
  .replace(/[\\/:*?"<>|]/g, '-')
  .replace(/[.,]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

// ⚠️ DATA W NAZWIE PLIKU IDZIE SAMYM DNIEM. `data_wystawienia` z KSeF potrafi niesc znacznik
// czasu, a dwukropek jest na Windowsie i SMB znakiem NIELEGALNYM — zapis padal i probowal
// co noc od nowa. Dziesiec znakow to dokladnie 'RRRR-MM-DD'; krotsza data zostaje, jaka jest.
export const doDnia = (data) => String(data ?? '').slice(0, 10);

export function katalogMiesiaca(dzien) {
  const [rok, miesiac] = doDnia(dzien).split('-');
  return { rok, miesiac: MIESIACE_KATALOGOW[Number(miesiac) - 1] };
}

/**
 * Sciezka PDF-u faktury sprzedazowej lub korekty WZGLEDEM katalogu archiwum.
 * Konwencja z plikow, ktore juz leza na NAS-ie (eksport z 1.08.2026):
 * `2026/Lipiec/2026-07-01_1-07-2026.pdf`, korekta `2026/Luty/2026-02-02_1-KOR-02-2026.pdf`.
 */
export function sciezkaArchiwumSprzedazy({ invoiceDate, numer }) {
  const dzien = doDnia(invoiceDate);
  const { rok, miesiac } = katalogMiesiaca(dzien);
  const nazwa = doNazwyPliku(numer) || 'bez-numeru';
  return `${rok}/${miesiac}/${dzien}_${nazwa}.pdf`;
}
