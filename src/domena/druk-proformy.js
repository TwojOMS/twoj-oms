// PRZ-152.G10a — druk proformy na komputerze z drukarką (ta sama droga co faktura: czuwacz-faktur.ps1).
//
// Decyzja właściciela 05.11.2026: „proforma nie musi być rozliczona ani aktualna. usuń te opcje. po prostu jest
// proforma.” — drukujemy KAŻDĄ proformę, która nie jest unieważniona. Unieważnionej odmawiamy: wydruk
// trafia do klienta, a nieważna proforma na papierze to przelew według złej kwoty.

/** `{ wolno, powod }` — powód to zdanie dla operatora (odpowiedź 400 trasy `POST /proformy/:id/drukuj`). */
export function czyWolnoDrukowacProforme(proforma) {
  if (proforma?.uniewazniona_at) {
    return {
      wolno: false,
      powod: `Proforma ${proforma.numer} jest unieważniona — nie drukujemy dokumentu, który nie obowiązuje.`,
    };
  }
  return { wolno: true, powod: null };
}

// Pozycje proform idą do czuwacza tą samą listą co faktury (`GET /kolejka-druku-faktur`), więc ich id
// musi się różnić od id pozycji faktur (osobne tabele, osobne liczniki). Czuwacz traktuje `$poz.id`
// jak napis — „p12” przechodzi przez niego bez zmiany skryptu.
const PRZEDROSTEK_PROFORMY = 'p';
const ID_PROFORMY = /^p([1-9]\d*)$/;

export const idPozycjiProformy = (idWiersza) => `${PRZEDROSTEK_PROFORMY}${idWiersza}`;

/**
 * Id z adresu `/kolejka-druku-faktur/:id/…`:
 * - „p<n>” → `{ rodzaj: 'proforma', id: n }`;
 * - napis z przedrostkiem, ale zniekształcony („px”, „p0”, „p01”) → `null` (trasa odda 404);
 * - bez przedrostka → `{ rodzaj: 'faktura', id: Number(napis) }` — dokładnie tak, jak trasa liczyła dotąd.
 */
export function rozpoznajPozycjeDruku(napis) {
  const s = String(napis ?? '');
  if (!s.startsWith(PRZEDROSTEK_PROFORMY)) return { rodzaj: 'faktura', id: Number(s) };
  const m = ID_PROFORMY.exec(s);
  return m ? { rodzaj: 'proforma', id: Number(m[1]) } : null;
}
