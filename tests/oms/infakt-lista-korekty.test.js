import { describe, it, expect } from 'vitest';
import { createInfaktClient, STRONA_INFAKTU, SUFIT_STRON } from '../../src/oms/infakt/client.js';

function fake(odpowiedzi) {
  const wolania = [];
  const impl = async (url) => {
    wolania.push(url);
    const trafienie = odpowiedzi.find(([wzor]) => url.includes(wzor));
    if (!trafienie) throw new Error(`Niespodziewany adres: ${url}`);
    return trafienie[1];
  };
  return { impl, wolania };
}
const strona = (entities, total = entities.length) => ({
  ok: true, status: 200, json: async () => ({ metainfo: { count: entities.length, total_count: total }, entities }),
});

// Fałszywy inFakt STRONICUJĄCY po `offset` — bo lista nieopłaconych to CAŁA historia, a nie
// miesiąc: fake oddający zawsze jedną stronę nie odróżniłby kompletu od pierwszych dziesięciu.
function fakeStrony({ total, wolania = [] }) {
  return async (url) => {
    wolania.push(url);
    const offset = Number(new URL(url).searchParams.get('offset') ?? 0);
    const entities = [];
    for (let i = offset; i < Math.min(offset + STRONA_INFAKTU, total); i += 1) {
      entities.push({ uuid: `f${i}`, number: `${i}/06/2026`, left_to_pay: 12300 });
    }
    return { ok: true, status: 200, json: async () => ({ metainfo: { count: entities.length, total_count: total }, entities }) };
  };
}

// Odpowiedź z popsutym `metainfo` — pełna strona wierszy, ale bez wiarygodnego kresu.
const zepsutyKres = (metainfo) => async () => ({
  ok: true,
  status: 200,
  json: async () => ({
    metainfo,
    entities: Array.from({ length: STRONA_INFAKTU }, (_, i) => ({ uuid: `f${i}`, left_to_pay: 12300 })),
  }),
});

describe('korekty i nieopłacone', () => {
  it('korekty idą z OSOBNEGO zasobu i są oznaczone rodzajem', async () => {
    const { impl, wolania } = fake([['corrective_invoices', strona([{ uuid: 'k1', number: '1/KOR/02/2026' }])]]);
    const c = createInfaktClient({ apiKey: 'x', fetchImpl: impl });
    const w = await c.listaKorekt({ od: '2026-02-01', do: '2026-02-28' });
    expect(w[0].rodzaj).toBe('korekta');
    expect(wolania[0]).toContain('/v3/corrective_invoices.json');
  });

  // ⚠️ FILTR ZMIERZONY, NIE ZGADNIĘTY (06.08.2026): `q[left_to_pay_gt]=0` oddaje 65 dokumentów
  // i w próbce ANI JEDNEGO z `left_to_pay = 0`. Odrzucone alternatywy: `q[status_not_eq]=paid`
  // i `q[paid_date_null]=true` — obie oddają 63 i OBIE przepuszczają dokumenty już opłacone
  // (1 na 10 w próbce), bo panel wystawia faktury przedpłacone z `paid_price`, a ich wewnętrzny
  // status bywa inny niż `paid`.
  it('nieopłacone filtruje po left_to_pay, a NIE po statusie', async () => {
    const { impl, wolania } = fake([['invoices', strona([{ uuid: 'f1', left_to_pay: 1000 }])]]);
    const c = createInfaktClient({ apiKey: 'x', fetchImpl: impl });
    await c.listaNieoplaconych();
    // ⚠️ `+` NORMALIZUJEMY TUTAJ, W TEŚCIE, a nie w kliencie. `URLSearchParams` koduje spację
    // jako `+`, a `decodeURIComponent` `+` na spację NIE zamienia — bez tej podmiany asercja
    // pilnowałaby kodowania zamiast treści i wymuszałaby w kliencie zbędne `.replace()`.
    // Zmierzone 06.08.2026: inFakt czyta `+` i `%20` IDENTYCZNIE (ten sam pierwszy wiersz).
    const adres = decodeURIComponent(wolania[0]).replace(/\+/g, ' ');
    expect(adres).toContain('q[left_to_pay_gt]=0');
    expect(adres).toContain('order=payment_date asc');
    expect(adres).not.toContain('status_eq');
    expect(adres).not.toContain('status_not_eq');
  });

  // ⚠️ TO JEST EKRAN DŁUGÓW KLIENTÓW. Lista nieopłaconych szła własną pętlą po stronach —
  // drugą w tym pliku — i przez to omijała strażniki `wszystkieStrony`. Poniższe trzy testy
  // pilnują, że JEST JEDNA ŚCIEŻKA PAGINACJI: te same zabezpieczenia, co dla listy faktur.
  it('nieopłacone oddają KOMPLET dokumentów, nie pierwszą stronę', async () => {
    const wolania = [];
    const c = createInfaktClient({ apiKey: 'x', fetchImpl: fakeStrony({ total: 65, wolania }) });
    const w = await c.listaNieoplaconych();
    expect(w).toHaveLength(65); // zmierzona liczba nieopłaconych na produkcji, 06.08.2026
    expect(wolania).toHaveLength(7); // 65 dokumentów / 10 na stronę
    expect(w[0].rodzaj).toBe('vat');
  });

  // Cichy zwrot dziesięciu wierszy zamiast sześćdziesięciu pięciu to zaniżony dług klientów —
  // wygląda dokładnie tak samo jak komplet. Odmowa jest tu jedyną uczciwą odpowiedzią.
  it('nieopłacone ODMAWIAJĄ, gdy total_count jest zepsuty albo go brak', async () => {
    const cBrak = createInfaktClient({ apiKey: 'x', fetchImpl: zepsutyKres({ count: STRONA_INFAKTU }) });
    await expect(cBrak.listaNieoplaconych()).rejects.toThrow(/nie poda[łl]|policzy[ćc]/i);

    const cTekst = createInfaktClient({
      apiKey: 'x',
      fetchImpl: zepsutyKres({ count: STRONA_INFAKTU, total_count: 'dużo' }),
    });
    await expect(cTekst.listaNieoplaconych()).rejects.toThrow(/nie poda[łl]|policzy[ćc]/i);
  });

  it('nieopłacone ODMAWIAJĄ zamiast oddać cichą część, gdy wynik przekracza sufit stron', async () => {
    const c = createInfaktClient({
      apiKey: 'x',
      fetchImpl: fakeStrony({ total: (SUFIT_STRON + 1) * STRONA_INFAKTU }),
    });
    await expect(c.listaNieoplaconych()).rejects.toThrow(/zaw[eę]ź|za du[żz]o|sufit/i);
  });

  // ⚠️ INNY ZASÓB. Ten sam uuid pod /invoices/ oddaje 404 — sprawdzone 2026-08-01.
  it('PDF korekty idzie pod /corrective_invoices/, nie pod /invoices/', async () => {
    const pdf = Buffer.from('%PDF-1.4 korekta');
    const { impl, wolania } = fake([['corrective_invoices', {
      ok: true, status: 200, arrayBuffer: async () => pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.length),
    }]]);
    const c = createInfaktClient({ apiKey: 'x', fetchImpl: impl });
    const bajty = await c.pobierzPdfKorekty('k1');
    expect(bajty.subarray(0, 4).toString()).toBe('%PDF');
    expect(wolania[0]).toContain('/v3/corrective_invoices/k1/pdf.json?document_type=original');
  });
});
