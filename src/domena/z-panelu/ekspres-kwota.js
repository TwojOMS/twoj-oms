// Dopłata za realizację ekspresową jako LICZBA.
//
// W ustawieniach (`quoteExpressPrice`) stoi TEKST do prawej kolumny tabeli w mailu — „+50zł",
// „+50 zł", „+50,00zł". Człowiek go pisze i człowiek go zmienia. Wszędzie tam, gdzie ekspres
// ma wejść do arytmetyki (kwota w mailu, dodatek na formularzu proformy, pozycja zamówienia
// w OMS-ie), potrzebna jest z niego LICZBA — i musi to być JEDNA reguła odczytu, bo dwie
// rozjechałyby się przy pierwszej zmianie zapisu.
//
// ⚠️ NIECZYTELNA WARTOŚĆ ODDAJE `null`, NIGDY ZERO. Zero znaczyłoby „ekspres za darmo" —
// klient dostałby dopłatę gratis albo zamówienie na kwotę niższą niż zaakceptowana, a wtedy
// `oplacone` (wymaga pokrycia CAŁEJ kwoty) nie zapaliłoby się nigdy i ETAP IV stanąłby po cichu.
// Wywołujący ma na `null` zareagować: mail pomija dopisek, formularz nie proponuje ekspresu.
export function kwotaEkspresu(raw) {
  const tekst = String(raw ?? '').trim();
  if (!tekst) return null;
  // Pierwsza liczba w tekście; przecinek dziesiętny dopuszczony, bo tak pisze się po polsku.
  // Znak „+" ignorujemy — to ozdobnik kolumny, nie działanie.
  //
  // ⚠️ ZNAK MUSI WEJŚĆ DO DOPASOWANIA, nie tylko liczba. Wzorzec bez niego czyta „-50zł"
  // jako 50 i ujemna dopłata przechodzi jako dodatnia — a wtedy pomyłka operatora w jedną
  // literę robi z ekspresu prawdziwą pozycję zamówienia zamiast zniknąć. Złapane testem.
  const m = tekst.match(/([+-]?)\s*(\d+(?:[.,]\d+)?)/);
  if (!m) return null;
  if (m[1] === '-') return null;
  const n = Number(m[2].replace(',', '.'));
  // Zero i wartość nieliczbowa nie są ekspresem, tylko brakiem dopłaty — a „ekspres gratis"
  // to nie jest decyzja, którą wolno podjąć przez pomyłkę w zapisie.
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
