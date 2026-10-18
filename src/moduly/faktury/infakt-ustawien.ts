// PRZ-093.10 — klient inFaktu z Ustawień (Ustawienia → Integracje → inFakt). Wzór: kurierDpdZUstawien /
// kurierInpostZUstawien w moduly/wysylka/kurierzy.ts.
//
// Pośrednik o tych samych metodach co createInfaktClient. Każde wywołanie czyta BIEŻĄCY zapis z bazy; nowy klient
// powstaje tylko, gdy zmieniły się opcje (klucz) — więc zmiana klucza działa od następnego żądania, bez restartu.
// Brak zapisu (odłączony) = odmowa dla operatora z adresem ekranu, zanim cokolwiek pójdzie do inFaktu.
// Usługi faktur (wystawianie, lista, KSeF, archiwum) moduł składa przy starcie — pierwsze podłączenie inFaktu
// w panelu bez inFaktu wymaga restartu (jak pierwszy kurier w PRZ-092); ekran to mówi.
import { METODY_INFAKTU } from '../../oms/infakt/client.js';
import { opcjeKlientaInfakt, EKRAN_INFAKTU } from '../../domena/konfiguracja-infakt.js';
import { bladOperatora } from '../../domena/bledy.js';

type ZapisInfakt = { ustawienia: Record<string, unknown>; sekrety: Record<string, unknown> };
type KlientInfakt = Record<string, (...a: any[]) => Promise<any>>;

export function infaktZUstawien({ wczytaj, fabryka }: {
  wczytaj: () => ZapisInfakt | null; fabryka: (o: ReturnType<typeof opcjeKlientaInfakt>) => KlientInfakt;
}): KlientInfakt {
  let klucz: string | null = null;
  let klient: KlientInfakt | null = null;
  const biezacy = (): KlientInfakt => {
    const zapis = wczytaj();
    const opcje = zapis ? opcjeKlientaInfakt(zapis) : null;
    // `status: 400` CELOWO, choć żadne żądanie nie poszło (ta sama zasada co pusty identyfikator w
    // wyslijDokumentDoKsef): usługi faktur rozpoznają jednoznaczną odmowę po 4xx i zwalniają rezerwację — bez
    // statusu odmowa wyglądałaby jak zerwane połączenie („nie wiadomo, czy faktura powstała”).
    // `bezInfaktu: true` — to NIE jest odpowiedź inFaktu o dokumencie (P2 z recenzji PRZ-093.10): czuwacz pobrań
    // (wysylka/services/oznaczanie-pobran.js) nie może z tej odmowy zrobić trwałego „inFakt nie zna faktury”.
    if (!opcje?.apiKey) {
      throw bladOperatora(`inFakt nie jest skonfigurowany — wpisz klucz API w Ustawienia → Integracje → inFakt (${EKRAN_INFAKTU}). Nic nie poszło do inFaktu.`, { status: 400, bezInfaktu: true });
    }
    const nowy = JSON.stringify(opcje);
    if (nowy !== klucz || !klient) { klient = fabryka(opcje); klucz = nowy; }
    return klient;
  };
  // Metody async: odmowa (brak zapisu) wraca jako odrzucona obietnica, jak błąd samego inFaktu.
  return Object.fromEntries(METODY_INFAKTU.map((m: string) => [m, async (...a: unknown[]) => biezacy()[m](...a)]));
}

/** Piaskownica bez atrapy VIES, a inFakt z Ustawień: VIES też nie wychodzi z panelu próby (sprawdzenie odmawia). */
export function odmowaViesWProbie() {
  return { sprawdz: async () => {
    throw bladOperatora('Piaskownica: prawdziwy VIES jest tu wyłączony — nic nie poszło do VIES.', { status: 400 });
  } };
}

/** Piaskownica bez atrapy: klucz wpisany na :3005 / demo nie wychodzi do inFaktu — każda metoda odmawia (4xx: nic nie poszło). */
export function odmowaInfaktuWProbie(): KlientInfakt {
  const odmowa = async () => {
    throw bladOperatora('Piaskownica: prawdziwy inFakt jest tu wyłączony — nic nie poszło do inFaktu ani KSeF.', { status: 400, bezInfaktu: true });
  };
  return Object.fromEntries(METODY_INFAKTU.map((m: string) => [m, odmowa]));
}
