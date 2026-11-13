// PRZ-119.03 — Fakturownia za kontraktem ProgramFakturowy (core/kontrakty.ts), na kliencie src/oms/fakturownia/client.js.
//
// W odróżnieniu od inFaktu (cienkie przekazanie) ten adapter TŁUMACZY: ładunek w kształcie v3 inFaktu → `invoice`
// Fakturowni i dokument Fakturowni → WierszDokumentu. Każde pole ciała żądania jest z pomiarów F1–F17
// (docs/plany/PRZ-119-pomiary.md, tests/fixtures/fakturownia/), test porównuje je pole po polu.
//
// Zasady (pomiary mają pierwszeństwo przed planem):
//  • kwoty: grosze ↔ napis „123.00” WYŁĄCZNIE na liczbach całkowitych i napisach — nigdy mnożenie liczby
//    zmiennoprzecinkowej przez 100;
//  • zawsze `calculating_strategy` (VAT od wiersza brutto, suma z wierszy) — w wystaw I w korekcie (F06);
//  • F10: Fakturownia przyjmuje (201) dokument bez nazwy nabywcy, ze stawką 22 i nieznanym rodzajem — więc nazwę,
//    stawkę (STAWKI_VAT) i rodzaj sprawdzamy TU, przed siecią (odmowa 400 = dokumentu na pewno nie ma);
//  • `oid` + `oid_unique` (F11): drugi dokument dla tego samego zamówienia → 422 na `oid` → odmowa z `duplikat: true`
//    (usługa NIE zwalnia wtedy rezerwacji — pierwszy dokument istnieje);
//  • zwykła faktura bez pól sprzedawcy (dane konta Fakturowni); korekta niesie dane sprzedawcy i nabywcy
//    Z KORYGOWANEGO dokumentu (F15);
//  • wystawienie nie wysyła do KSeF. Jeśli konto Fakturowni zrobi to samo (`gov_status` w odpowiedzi poza
//    null / not_connected / not_applicable) — dokument zostaje, a trwały alarm dostaje wpis (gasi go tylko operator).
//
// ⚠️ Import cykliczny z ../program-fakturowy.ts: listy metod czytamy WYŁĄCZNIE wewnątrz programFakturownia.
import type { OdmianaNazwy, OpisProgramu, ProgramFakturowy, ZdolnoscProgramu, NabywcaDokumentu } from '../../core/kontrakty.ts';
import { METODA_ZDOLNOSCI } from '../program-fakturowy.ts';
import {
  LIMIT_ZADANIA_MS, NAJDLUZSZA_LISTA_MS, STRONA_FAKTUROWNI, SUFIT_STRON,
} from '../../oms/fakturownia/client.js';
import { bladOperatora } from '../../domena/bledy.js';
import { STAWKI_VAT } from '../../domena/vat.js';
import { czyNipUe, rozbijNipUe } from '../../domena/wdt.js';
import { normalizujNip } from '../../domena/klient-zbiorczy.js';
import { dzienWarszawa } from '../../domena/format-daty.js';

type KlientFakturowni = Readonly<Record<string, unknown>>;
type Metoda = (...a: unknown[]) => unknown;
type Surowy = Record<string, unknown>;
type AlarmAutoKsef = Readonly<{ dopisz: (wpis: Readonly<Record<string, unknown>>) => unknown }>;

export const NAZWA_FAKTUROWNI: OdmianaNazwy = Object.freeze({
  mianownik: 'Fakturownia', dopelniacz: 'Fakturowni', miejscownik: 'Fakturowni', narzednik: 'Fakturownią',
}) as OdmianaNazwy;
export const ADRES_FAKTUROWNI = 'https://fakturownia.pl';
export { EKRAN_FAKTUROWNI } from '../../domena/konfiguracja-fakturownia.js';
import { EKRAN_FAKTUROWNI } from '../../domena/konfiguracja-fakturownia.js';

/** F06: VAT liczony od wiersza brutto, suma dokumentu = suma wierszy (tak liczy podsumowanieWierszami). */
const STRATEGIA = Object.freeze({ position: 'default', sum: 'sum', invoice_form_price_kind: 'gross' });
/** `gov_status`, przy którym dokument NIE poszedł do KSeF sam z siebie. */
const BEZ_AUTOWYSYLKI = new Set<unknown>([null, undefined, 'not_connected', 'not_applicable']);
/** `gov_status` dokumentu przyjętego przez KSeF — tylko wtedy `gov_id` jest numerem KSeF (decyzja kierownika, recenzja 03). */
const PRZYJETY_W_KSEF = new Set<unknown>(['ok', 'demo_ok']);
/** Sposób płatności v3 → `payment_type` Fakturowni. Brak = przelew (jak inFakt). */
const PLATNOSC: Readonly<Record<string, string>> = Object.freeze({ transfer: 'transfer', delivery: 'cash_on_delivery' });
const PLATNOSC_WSTECZ: Readonly<Record<string, string>> = Object.freeze({ transfer: 'transfer', cash_on_delivery: 'delivery' });
/** Pola nabywcy i sprzedawcy przepisywane z korygowanego dokumentu (F15 #2). */
const POLA_NABYWCY = ['buyer_company', 'buyer_name', 'buyer_tax_no', 'buyer_tax_no_kind', 'buyer_street', 'buyer_post_code', 'buyer_city', 'buyer_country', 'buyer_email'] as const;
const POLA_SPRZEDAWCY = ['seller_name', 'seller_tax_no', 'seller_street', 'seller_post_code', 'seller_city', 'seller_country'] as const;
/** Zakres wystawienia przy szukaniu po dacie sprzedaży: faktura bywa do 30 dni przed sprzedażą i do 15. następnego miesiąca. */
const DNI_PRZED_SPRZEDAZA = 30;

const odmowa = (komunikat: string) => bladOperatora(komunikat, { status: 400 });
// PRZ-119.11a: profil próby Fakturowni (prywatna piaskownica) — KSeF tylko na atrapie, nigdy przez prawdziwe konto.
export const ODMOWA_KSEF_PIASKOWNICY = 'Piaskownica: wysyłka do KSeF przez prawdziwą Fakturownię jest wyłączona — sprawdzisz ją na atrapie.';

/** Grosze (liczba całkowita) → „123.00”. Bez dzielenia zmiennoprzecinkowego. */
export function napisZGroszy(grosze: unknown): string {
  if (typeof grosze !== 'number' || !Number.isSafeInteger(grosze)) {
    throw odmowa(`Kwota ${String(grosze)} nie jest liczbą całkowitą groszy.`);
  }
  const znak = grosze < 0 ? '-' : '';
  const abs = Math.abs(grosze);
  return `${znak}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** „123.0”, „-0.99”, „1234567.89” → grosze. Tylko na napisie (cyfry przed i po kropce), bez parseFloat. */
export function groszeZNapisu(napis: unknown): number {
  const s = typeof napis === 'number' && Number.isFinite(napis) ? String(napis) : napis;
  const m = typeof s === 'string' ? /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s.trim()) : null;
  if (!m) throw bladOperatora(`Fakturownia oddała kwotę „${String(napis)}”, której panel nie umie odczytać co do grosza.`);
  const grosze = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(grosze)) throw bladOperatora(`Kwota „${String(napis)}” jest poza zakresem panelu.`);
  return m[1] === '-' && grosze !== 0 ? -grosze : grosze;
}

const tekst = (v: unknown) => (v == null ? '' : String(v).trim());
const bezPustych = (o: Surowy): Surowy => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));

function stawka(symbol: unknown, wdt: boolean): number | string {
  const s = tekst(symbol);
  if (!STAWKI_VAT.includes(s)) {
    throw odmowa(`Stawka VAT „${s}” nie jest obsługiwana w Fakturowni (dozwolone: ${STAWKI_VAT.join(', ')}). Dokument NIE został wystawiony.`);
  }
  if (wdt) {
    if (s !== '0') throw odmowa(`Dokument WDT ma stawkę 0%, a pozycja ma ${s}%. Dokument NIE został wystawiony.`);
    return '0'; // F14 #2: przy WDT stawka jako napis "0"
  }
  return Number(s);
}

function iloscPozycji(v: unknown, { zero = false } = {}): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || (!zero && v === 0)) {
    throw odmowa(`Ilość pozycji „${String(v)}” jest nieprawidłowa. Dokument NIE został wystawiony.`);
  }
  return v;
}

function nazwaPozycji(v: unknown): string {
  const n = tekst(v);
  if (!n) throw odmowa('Pozycja dokumentu nie ma nazwy. Dokument NIE został wystawiony.');
  return n;
}

/** Odpowiedź 4xx Fakturowni → odmowa zrozumiała dla operatora; inne błędy bez zmian. */
function przetlumaczOdmowe(e: unknown, oid: string | null): unknown {
  const b = e as { status?: unknown; tresc?: { message?: unknown } } | null;
  const pola = b?.status === 422 && b.tresc && typeof b.tresc.message === 'object' && b.tresc.message
    ? Object.keys(b.tresc.message as object) : [];
  if (oid && pola.includes('oid')) {
    return bladOperatora(
      `Już jest faktura dla zamówienia ${oid} w Fakturowni — drugi dokument NIE powstał. Sprawdź ją w Fakturowni.`,
      { status: 422, duplikat: true, tresc: b?.tresc },
    );
  }
  if (pola.some((p) => p.startsWith('seller_'))) {
    return bladOperatora(
      'Uzupełnij dane firmy w Fakturowni (Ustawienia konta) — bez nich Fakturownia nie wystawi dokumentu. Dokument NIE powstał.',
      { status: 422, tresc: b?.tresc },
    );
  }
  return e;
}

/** Dokument, który przyszedł w odpowiedzi na wystawienie — bez `id` nie wiemy, co powstało (bez statusu = do wyjaśnienia). */
function idDokumentu(odp: unknown): string {
  const id = (odp as Surowy | null)?.id;
  if (id === undefined || id === null || tekst(id) === '') {
    throw bladOperatora('Fakturownia przyjęła dokument, ale nie oddała jego numeru wewnętrznego — sprawdź go w Fakturowni.');
  }
  return tekst(id);
}

type DaneNabywcy = Readonly<{ rodzaj: 'dane'; firma: string; nip: string; ulica: string; kod: string; miasto: string; kraj: string; email: string }>;
type WpisKartoteki = Readonly<{ rodzaj: 'kartoteka'; wpis: Readonly<Surowy> }>;

export function programFakturownia(
  klient: KlientFakturowni,
  {
    nazwa = NAZWA_FAKTUROWNI, adres = ADRES_FAKTUROWNI, ekran = EKRAN_FAKTUROWNI, alarmAutoKsef,
    teraz = () => new Date(), piaskownica,
  }: {
    nazwa?: OdmianaNazwy; adres?: string; ekran?: string; alarmAutoKsef?: AlarmAutoKsef; teraz?: () => Date;
    // PRZ-119.11a: profil próby — `oid` z prefiksem `proba-<znacznik bazy>-` (reset bazy demo nie zderza numerów
    // z fakturami na koncie próbnym), wysyłka do KSeF odmawia przed klientem.
    piaskownica?: { znacznik: () => string };
  } = {},
): ProgramFakturowy {
  if (!alarmAutoKsef || typeof alarmAutoKsef.dopisz !== 'function') {
    throw new Error('Adapter Fakturowni wymaga magazynu alarmu auto-KSeF (alarmAutoKsef) — bez niego samowolna wysyłka przeszłaby po cichu.');
  }
  const ma = (m: string) => typeof klient[m] === 'function';
  const wolaj = (m: string, ...a: unknown[]) => (klient[m] as Metoda)(...a);
  const dzis = () => dzienWarszawa(teraz().toISOString()) as string;

  function sprawdzAutoKsef(odp: unknown, oid: string | null): void {
    const d = odp as Surowy;
    if (BEZ_AUTOWYSYLKI.has(d?.gov_status)) return;
    try {
      alarmAutoKsef!.dopisz({ dokument: tekst(d.id), numer: d.number ?? null, gov_status: d.gov_status, oid });
    } catch (e) {
      // Dokument już jest — błąd zapisu alarmu nie może udawać, że wystawienie się nie udało.
      console.error('[fakturownia] nie zapisano alarmu auto-KSeF:', (e as Error)?.message);
    }
  }

  async function przygotujNabywce(
    nabywca: NabywcaDokumentu, { zalozGdyBrak = false }: Readonly<{ zalozGdyBrak?: boolean }> = {},
  ): Promise<{ client_id: unknown } | null> {
    if (zalozGdyBrak) {
      // Fakturownia zakłada wpis kartoteki sama z pól buyer_* — bez osobnego żądania (F04).
      const dane: DaneNabywcy = Object.freeze({
        rodzaj: 'dane', firma: tekst(nabywca.firma), nip: tekst(nabywca.nip), ulica: tekst(nabywca.ulica),
        kod: tekst(nabywca.kod), miasto: tekst(nabywca.miasto), kraj: tekst(nabywca.kraj), email: tekst(nabywca.email),
      });
      return { client_id: dane };
    }
    const nip = normalizujNip(nabywca.nip);
    if (!nip) return null;
    const wpisy = (await wolaj('znajdzKlientowPoNip', tekst(nabywca.nip))) as Surowy[];
    const zgodne = (Array.isArray(wpisy) ? wpisy : []).filter((w) => normalizujNip(w?.tax_no) === nip);
    if (zgodne.length > 1) {
      throw odmowa(`W kartotece Fakturowni jest ${zgodne.length} klientów z NIP-em ${tekst(nabywca.nip)} — zostaw jednego i spróbuj ponownie.`);
    }
    return zgodne.length ? { client_id: Object.freeze({ rodzaj: 'kartoteka', wpis: Object.freeze({ ...zgodne[0] }) }) } : null;
  }

  function polaNabywcy(clientId: unknown): { pola: Surowy; wdt: boolean } {
    const c = clientId as DaneNabywcy | WpisKartoteki | null;
    if (c?.rodzaj === 'kartoteka') {
      const w = c.wpis;
      const nip = tekst(w.tax_no);
      if (!tekst(w.name)) throw odmowa('Nabywca w kartotece Fakturowni nie ma nazwy. Dokument NIE został wystawiony.');
      const wdt = czyNipUe(nip);
      return {
        wdt,
        pola: bezPustych({
          client_id: w.id, buyer_company: Boolean(nip), buyer_name: tekst(w.name), buyer_tax_no: nip,
          buyer_street: tekst(w.street), buyer_post_code: tekst(w.post_code), buyer_city: tekst(w.city),
          buyer_country: wdt ? rozbijNipUe(nip)!.kraj : tekst(w.country) || 'PL', buyer_email: tekst(w.email),
        }),
      };
    }
    if (c?.rodzaj !== 'dane') throw odmowa('Brak danych nabywcy dla Fakturowni. Dokument NIE został wystawiony.');
    if (!tekst(c.firma)) throw odmowa('Nabywca nie ma nazwy — Fakturownia wystawiłaby dokument bez nabywcy. Dokument NIE został wystawiony.');
    const wdt = czyNipUe(c.nip);
    return {
      wdt,
      pola: bezPustych({
        buyer_company: Boolean(c.nip), buyer_name: c.firma, buyer_tax_no: c.nip, buyer_street: c.ulica,
        buyer_post_code: c.kod, buyer_city: c.miasto,
        // Przy WDT kraj z prefiksu numeru (zamówienie ręczne oddaje domyślne 'PL').
        buyer_country: wdt ? rozbijNipUe(c.nip)!.kraj : c.kraj || 'PL', buyer_email: c.email,
      }),
    };
  }

  async function wystaw(ladunek: Surowy, opcje: Readonly<{ oid?: unknown }> = {}) {
    const numer = tekst(opcje?.oid);
    if (!numer) throw odmowa('Brak identyfikatora zamówienia (oid) — bez niego Fakturownia nie odróżni drugiego wystawienia. Dokument NIE został wystawiony.');
    const oid = piaskownica ? `proba-${piaskownica.znacznik()}-${numer}` : numer;
    const { pola, wdt } = polaNabywcy(ladunek.client_id);
    const services = ladunek.services as Surowy[] | undefined;
    if (!Array.isArray(services) || services.length === 0) throw odmowa('Dokument bez pozycji. Dokument NIE został wystawiony.');
    let suma = 0;
    const positions = services.map((s) => {
      suma += typeof s.gross_price === 'number' ? s.gross_price : NaN;
      return {
        name: nazwaPozycji(s.name), quantity: iloscPozycji(s.quantity), tax: stawka(s.tax_symbol, wdt),
        total_price_gross: napisZGroszy(s.gross_price),
      };
    });
    const sposob = ladunek.payment_method === undefined ? 'transfer' : tekst(ladunek.payment_method);
    const paymentType = PLATNOSC[sposob];
    if (!paymentType) throw odmowa(`Sposób płatności „${sposob}” nie jest obsługiwany w Fakturowni. Dokument NIE został wystawiony.`);
    const kind = wdt ? 'wdt' : 'vat';
    const issueDate = tekst(ladunek.invoice_date) || dzis();
    const sellDate = tekst(ladunek.sale_date) || issueDate;
    const zaplacono = ladunek.paid_price === undefined || ladunek.paid_price === null ? 0 : ladunek.paid_price;
    // PRZ-119.12c, pomiar F9B: `status: paid` bez `paid_date` → Fakturownia wpisuje DZIŚ. Dlatego data zapłaty
    // nigdy pusta: z ładunku (dzień opłacenia — services/faktura.js), a bez niej data sprzedaży (np. faktura okresu).
    const zaplata = zaplacono === 0 ? {} : {
      status: zaplacono === suma ? 'paid' : 'partial',
      paid: napisZGroszy(zaplacono),
      paid_date: tekst(ladunek.paid_date) || sellDate,
    };
    const invoice = bezPustych({
      kind,
      issue_date: issueDate,
      sell_date: sellDate,
      payment_to: ladunek.payment_date,
      payment_type: paymentType,
      currency: 'PLN',
      ...pola,
      // Pomiar F14: bez jawnego rodzaju numeru Fakturownia zostawia `buyer_tax_no_kind: null` przy numerze VAT UE.
      ...(wdt ? { buyer_tax_no_kind: 'nip_ue' } : {}),
      description: ladunek.notes,
      positions,
      ...zaplata,
      number: ladunek.number,
      calculating_strategy: STRATEGIA,
      oid,
      oid_unique: 'yes',
    });
    if (invoice.kind !== 'vat' && invoice.kind !== 'wdt') throw odmowa('Nieznany rodzaj dokumentu.');
    let odp: unknown;
    try {
      odp = await wolaj('wystaw', invoice);
    } catch (e) {
      throw przetlumaczOdmowe(e, oid);
    }
    const uuid = idDokumentu(odp);
    sprawdzAutoKsef(odp, oid);
    const d = odp as Surowy;
    return { uuid, numer: d.number ?? null, ksefStatus: d.gov_status ?? null };
  }

  async function wystawKorekte(ladunek: Surowy) {
    const idRodzica = tekst(ladunek.corrected_invoice_uuid);
    if (!/^\d+$/.test(idRodzica)) throw odmowa('Korekta bez wskazania faktury korygowanej w Fakturowni. Korekta NIE została wystawiona.');
    const services = ladunek.services as Surowy[] | undefined;
    if (!Array.isArray(services) || services.length === 0) throw odmowa('Korekta bez pozycji. Korekta NIE została wystawiona.');
    // Decyzja (b): dane sprzedawcy i nabywcy z KORYGOWANEGO dokumentu (stan na fakturze, nie dzisiejsza kartoteka).
    const rodzic = (await wolaj('pobierzFakture', idRodzica)) as Surowy;
    const wdt = rodzic?.kind === 'wdt';
    const grupy = new Map<string, { przed?: Surowy; po?: Surowy }>();
    for (const s of services) {
      const g = grupy.get(tekst(s.group)) ?? {};
      if (s.correction === true) g.po = s; else g.przed = s;
      grupy.set(tekst(s.group), g);
    }
    const positions = [...grupy.values()].map(({ przed, po }) => {
      if (!przed || !po) throw odmowa('Pozycja korekty nie ma pary „przed” i „po”. Korekta NIE została wystawiona.');
      const name = nazwaPozycji(przed.name);
      const tax = stawka(przed.tax_symbol, wdt);
      if (tekst(po.tax_symbol) !== tekst(przed.tax_symbol)) throw odmowa('Korekta zmienia stawkę VAT pozycji — wystaw ją ręcznie w Fakturowni.');
      const iloscPrzed = iloscPozycji(przed.quantity, { zero: true });
      const iloscPo = iloscPozycji(po.quantity, { zero: true });
      const bruttoPrzed = napisZGroszy(przed.gross_price);
      const bruttoPo = napisZGroszy(po.gross_price);
      return {
        name,
        quantity: iloscPo - iloscPrzed,
        total_price_gross: napisZGroszy((po.gross_price as number) - (przed.gross_price as number)),
        tax,
        kind: 'correction',
        correction_before_attributes: { name, quantity: iloscPrzed, total_price_gross: bruttoPrzed, tax, kind: 'correction_before' },
        correction_after_attributes: { name: nazwaPozycji(po.name), quantity: iloscPo, total_price_gross: bruttoPo, tax, kind: 'correction_after' },
      };
    });
    const invoice = bezPustych({
      kind: 'correction',
      invoice_id: Number(idRodzica),
      from_invoice_id: Number(idRodzica),
      correction_reason: tekst(ladunek.correction_reason),
      issue_date: dzis(),
      sell_date: tekst(rodzic?.sell_date) || dzis(),
      ...Object.fromEntries(POLA_NABYWCY.map((p) => [p, rodzic?.[p]])),
      ...Object.fromEntries(POLA_SPRZEDAWCY.map((p) => [p, rodzic?.[p]])),
      description: ladunek.notes,
      positions,
      calculating_strategy: STRATEGIA,
    });
    let odp: unknown;
    try {
      odp = await wolaj('wystawKorekte', invoice);
    } catch (e) {
      throw przetlumaczOdmowe(e, null);
    }
    const uuid = idDokumentu(odp);
    sprawdzAutoKsef(odp, null);
    return { referencja: null, uuid, numer: (odp as Surowy).number ?? null };
  }

  /** Pozycja Fakturowni → pozycja v3 (gross_price = suma linii brutto w groszach). Korekta: stawka z „przed” (F15 #3). */
  function pozycja(p: Surowy) {
    const przed = p.correction_before as Surowy | undefined;
    const tax = tekst(p.tax) || tekst(przed?.tax);
    return { name: p.name, quantity: Number(p.quantity), gross_price: groszeZNapisu(p.total_price_gross), tax_symbol: tax };
  }

  function wiersz(d: Surowy) {
    const brutto = groszeZNapisu(d.price_gross);
    const zaplacono = groszeZNapisu(d.paid ?? '0');
    const korekta = d.kind === 'correction';
    const rodzic = d.from_invoice_id ?? d.invoice_id;
    const imie = d.buyer_first_name ?? null;
    const nazwisko = d.buyer_last_name ?? null;
    // Osoba prywatna: domena składa nabywcę z imienia i nazwiska, gdy nie ma nazwy firmy (eksport CSV, paczka);
    // bez imienia i nazwiska zostaje buyer_name, żeby nabywca nie zniknął z listy.
    const osoba = d.buyer_company === false && Boolean(tekst(imie) || tekst(nazwisko));
    return {
      uuid: tekst(d.id),
      number: d.number ?? null,
      // Kanon v3: zwykła faktura to 'vat' (filtr typu, doZestawienia, ksefZListy w domena/lista-faktur.js).
      rodzaj: korekta ? 'korekta' : 'vat',
      kind: d.kind ?? null,
      status: d.status ?? null,
      invoice_date: d.issue_date ?? null,
      sale_date: d.sell_date ?? null,
      payment_date: d.payment_to ?? null,
      payment_method: PLATNOSC_WSTECZ[tekst(d.payment_type)] ?? d.payment_type ?? null,
      paid_date: d.paid_date ?? null,
      // Domena (stanKsef, wKsef) traktuje samą obecność numeru jako „jest w KSeF” — tylko dokument przyjęty.
      ksef_number: PRZYJETY_W_KSEF.has(d.gov_status) ? (d.gov_id ?? null) : null,
      gov_status: d.gov_status ?? null,
      net_price: groszeZNapisu(d.price_net),
      tax_price: groszeZNapisu(d.price_tax),
      gross_price: brutto,
      paid_price: zaplacono,
      left_to_pay: brutto - zaplacono,
      currency: d.currency ?? null,
      updated_at: d.updated_at ?? null,
      client_id: d.client_id ?? null,
      client_company_name: osoba ? null : (d.buyer_name ?? null),
      client_first_name: imie,
      client_last_name: nazwisko,
      client_tax_code: d.buyer_tax_no ?? null,
      client_nip: d.buyer_tax_no ?? null,
      ...(korekta && rodzic != null ? { parent_id: tekst(rodzic) } : {}),
      services: Array.isArray(d.positions) ? (d.positions as Surowy[]).map(pozycja) : [],
    };
  }

  async function pobierzSurowy(id: unknown): Promise<Surowy | null> {
    try {
      return (await wolaj('pobierzFakture', id, { correction_positions: 'full' })) as Surowy;
    } catch (e) {
      if ((e as { status?: unknown })?.status === 404) return null;
      throw e;
    }
  }

  async function pobierzFakture(id: unknown) {
    const d = await pobierzSurowy(id);
    if (!d) return null;
    const w: Surowy = wiersz(d);
    if (w.rodzaj === 'korekta' && w.parent_id) {
      // Numer korygowanej faktury — korekta Fakturowni niesie tylko jej id.
      const r = await pobierzSurowy(w.parent_id);
      w.corrected_invoice_number = r?.number ?? null;
    }
    return w;
  }

  const wDniach = (dzien: string, dni: number) => {
    const d = new Date(`${dzien}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + dni);
    return d.toISOString().slice(0, 10);
  };
  /** 15. dzień miesiąca po miesiącu `dzien`. */
  const pietnastyNastepnego = (dzien: string) => {
    const [r, m] = dzien.split('-').map(Number);
    return m === 12 ? `${r + 1}-01-15` : `${r}-${String(m + 1).padStart(2, '0')}-15`;
  };

  async function lista(zapytanie: Surowy, opcje: unknown, rodzaje: Surowy) {
    const od = tekst(zapytanie?.od);
    const doDnia = tekst(zapytanie?.do);
    const pole = zapytanie?.pole === 'sale_date' ? 'sale_date' : 'invoice_date';
    // Bez `period` Fakturownia oddaje „ten miesiąc” — zawsze jawnie: zakres (`more`) albo wszystko (`all`).
    const parametry: Surowy = od && doDnia
      ? {
        period: 'more',
        date_from: pole === 'sale_date' ? wDniach(od, -DNI_PRZED_SPRZEDAZA) : od,
        date_to: pole === 'sale_date' ? pietnastyNastepnego(doDnia) : doDnia,
      }
      : { period: 'all' };
    const surowe = (await wolaj('listaFaktur', { ...parametry, include_positions: 'true', ...rodzaje }, ...(opcje ? [opcje] : []))) as Surowy[];
    const wiersze = surowe.map(wiersz);
    if (!(od && doDnia)) return wiersze;
    return wiersze.filter((w) => {
      const dzien = tekst((w as Surowy)[pole]);
      return dzien >= od && dzien <= doDnia;
    });
  }

  const listaFaktur = (zapytanie: Surowy = {}, opcje?: unknown) => lista(zapytanie, opcje, { 'kinds[]': ['vat', 'wdt'] });
  /**
   * Korekty z numerem korygowanej faktury (`corrected_invoice_number` — czytają go widok faktur i zwroty).
   * Korekta Fakturowni niesie tylko id rodzica: jedno pobranie na rodzica, po kolei; 404 → null, inny
   * błąd przerywa listę (jak `pobierzFakture` — lepiej brak listy niż korekta bez faktury).
   */
  async function listaKorekt(zapytanie: Surowy = {}, opcje?: unknown) {
    const wiersze = (await lista(zapytanie, opcje, { kind: 'correction' })) as Surowy[];
    const numery = new Map<string, string | null>();
    for (const w of wiersze) {
      if (!w.parent_id) { w.corrected_invoice_number = null; continue; }
      const rodzic = String(w.parent_id);
      if (!numery.has(rodzic)) numery.set(rodzic, ((await pobierzSurowy(rodzic))?.number as string | undefined) ?? null);
      w.corrected_invoice_number = numery.get(rodzic) ?? null;
    }
    return wiersze;
  }

  const obowiazkowe: Record<string, Metoda> = {
    sprawdzPolaczenie: () => wolaj('sprawdzPolaczenie'),
    wystaw: wystaw as Metoda,
    wystawKorekte: wystawKorekte as Metoda,
    pobierzPdf: (id: unknown) => wolaj('pobierzPdf', id),
    pobierzPdfKorekty: (id: unknown) => wolaj('pobierzPdf', id),
    pobierzFakture: pobierzFakture as Metoda,
    listaFaktur: listaFaktur as Metoda,
    listaKorekt: listaKorekt as Metoda,
  };

  // Metody opcjonalne: obecne ⇔ klient ma metodę W CHWILI OWIJANIA; zdolność ⇔ metoda w programie.
  const opcjonalne: Record<string, Metoda> = {
    // Data zapłaty (`paidDate`) idzie do klienta: po `change_status` zapisuje ją osobnym PUT (PRZ-119.05).
    async oznaczZaplacona(id: unknown, opcje?: unknown) {
      const { paidDate } = (opcje && typeof opcje === 'object' ? opcje : {}) as { paidDate?: unknown };
      return paidDate === undefined || paidDate === null
        ? (klient.oznaczZaplacona as Metoda)(id)
        : (klient.oznaczZaplacona as Metoda)(id, { paidDate });
    },
    async wyslijDokumentDoKsef(id: unknown) {
      if (piaskownica) throw bladOperatora(ODMOWA_KSEF_PIASKOWNICY, { status: 400, bezProgramu: true });
      return (klient.wyslijDokumentDoKsef as Metoda)(id);
    },
    async iluMaNumer(numer: unknown) { return (klient.iluMaNumer as Metoda)(numer); },
  };
  const METODY_OPCJONALNE = ['oznaczZaplacona', 'wyslijDokumentDoKsef', 'iluMaNumer'];
  const metody: Record<string, Metoda> = { ...obowiazkowe };
  for (const m of METODY_OPCJONALNE) if (ma(m)) metody[m] = opcjonalne[m];

  const zdolnosci = (Object.entries(METODA_ZDOLNOSCI) as [ZdolnoscProgramu, string][])
    .filter(([, metoda]) => metoda in metody).map(([zdolnosc]) => zdolnosc);
  const opis: OpisProgramu = Object.freeze({
    id: 'fakturownia',
    nazwa: Object.freeze({ ...nazwa }),
    regulaVat: 'wierszami',
    zdolnosci: Object.freeze(zdolnosci),
    wystawienieWysylaDoKsef: false,
    // Pomiar F9B: `paid_date` przyjęta w utworzeniu i w PUT, także sprzed daty wystawienia i sprzedaży.
    dowolnaDataZaplaty: true,
    limity: Object.freeze({
      zadanieMs: LIMIT_ZADANIA_MS, najdluzszaListaMs: NAJDLUZSZA_LISTA_MS, stronaListy: STRONA_FAKTUROWNI,
      sufitStron: SUFIT_STRON, rownolegleStron: 1,
    }),
    adres,
    ekran,
  });

  return { opis, przygotujNabywce, ...metody } as unknown as ProgramFakturowy;
}
