// Czysta domena nocnego archiwum sprzedazy (services/czuwacz-archiwum-sprzedazy.js):
// odcisk dokumentu, rozstrzygniecie „nowy / bez zmian / zmieniony" i zakres miesiecy.
// Bez sieci, bez bazy, bez dysku.

// ⚠️ PODLOGA JEST STALA, NIE PARAMETREM (lekcja `SHOP_<SKLEP>_OD`): styczen 2026 to
// poczatek roku, za ktory biuro rachunkowe dostaje paczki; nizej nie ma czego archiwizowac.
export const PODLOGA_ARCHIWUM_SPRZEDAZY = '2026-01';

// Ile miesiecy wstecz przeglada kazdy nocny przebieg po zrobionej podlodze. Dwa (plus
// biezacy = trzy miesiace) pokrywaja korekty i faktury wystawiane z opoznieniem oraz
// poprawki dokumentow, ktore inFakt pozwala edytowac, dopoki nie poszly do KSeF.
export const MIESIECY_WSTECZ = 2;

// ⚠️ inFakt NIE MA `updated_at` (pomiar 2026-09-02) — jedyna droga wykrycia poprawionej
// faktury jest odcisk z pol, ktore decyduja o tresci dokumentu. Status platnosci, `paid_date`
// i `left_to_pay` do odcisku NIE wchodza: oplacenie nie zmienia wydrukowanego dokumentu,
// a wchodziloby w odcisk kazdej faktury raz na miesiac, czyli pobieralo cale archiwum od nowa.
const POLA_ODCISKU = ['number', 'invoice_date', 'sale_date', 'gross_price', 'client_tax_code', 'ksef_number'];

export function odciskDokumentu(dok) {
  const o = {};
  for (const pole of POLA_ODCISKU) o[pole] = dok?.[pole] ?? null;
  return JSON.stringify(o);
}

export function rozstrzygnij({ dokument, wiersz }) {
  if (!wiersz) return 'nowy';
  return wiersz.odcisk === odciskDokumentu(dokument) ? 'bez_zmian' : 'zmieniony';
}

export const rodzajDokumentu = (dok) => (
  (dok?.kind === 'correction' || dok?.rodzaj === 'korekta') ? 'korekta' : 'vat'
);

const przesunMiesiac = (rrrrMm, oIle) => {
  const [r, m] = rrrrMm.split('-').map(Number);
  const idx = r * 12 + (m - 1) + oIle;
  const rok = Math.floor(idx / 12);
  const mies = (idx % 12) + 1;
  return `${rok}-${String(mies).padStart(2, '0')}`;
};

/** Lista miesiecy `RRRR-MM` rosnaco: od podlogi (pierwszy przebieg) albo od `dzis - 2` do `dzis`. */
export function miesiaceDoPrzegladu({ dzis, podlogaZrobiona }) {
  const biezacy = String(dzis).slice(0, 7);
  let od = podlogaZrobiona ? przesunMiesiac(biezacy, -MIESIECY_WSTECZ) : PODLOGA_ARCHIWUM_SPRZEDAZY;
  if (od < PODLOGA_ARCHIWUM_SPRZEDAZY) od = PODLOGA_ARCHIWUM_SPRZEDAZY;
  const wynik = [];
  for (let m = od; m <= biezacy; m = przesunMiesiac(m, 1)) wynik.push(m);
  return wynik;
}
