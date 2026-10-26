export type OpcjeHttp = {
  limitCzasuMs?: number; // 30 000 ms na każdą próbę pobrania odpowiedzi
  ponowien?: number; // 2 dodatkowe próby, wyłącznie dla żądań idempotentnych
  maksCzekaniaMs?: number; // 60 000 ms; większy odstęp oddaje odpowiedź klientowi
  fetchImpl?: typeof fetch;
  czekaj?: (ms: number) => Promise<void>;
  log?: (t: string) => void;
};

const sekretneParametry = new Set([
  'access_token', 'token', 'apikey', 'api_key', 'key', 'secret', 'password',
  'code', 'refresh_token', 'client_secret', 'id_token', 'signature', 'sig', 'auth',
  'q[nip_eq]', 'nip_eq', 'requesternumber',
]);

function odtwarzalne(body: RequestInit['body']): boolean {
  return body == null || typeof body === 'string' || body instanceof URLSearchParams
    || body instanceof Blob || body instanceof FormData || body instanceof ArrayBuffer
    || ArrayBuffer.isView(body);
}

// Klienci rozpoznają anulowanie i kody systemowe. Treść/cause nie opuszcza transportu.
function metadaneBledu(blad: Error, przyczyna: unknown): Error {
  if (!przyczyna || typeof przyczyna !== 'object') return blad;
  const dane = przyczyna as Record<string, unknown>;
  if (dane.name === 'AbortError' || dane.name === 'TimeoutError') blad.name = dane.name;
  const cause = dane.cause;
  const kod = cause && typeof cause === 'object'
    ? (cause as Record<string, unknown>).code ?? dane.code : dane.code;
  if (typeof kod === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(kod)) {
    (blad as Error & { code?: string }).code = kod;
  }
  return blad;
}

function adresDoLogu(url: URL): string {
  const bezpieczny = new URL(url);
  bezpieczny.username = '';
  bezpieczny.password = '';
  bezpieczny.hash = '';
  // Numer kontrahenta jest częścią operacji VIES; kraj i operacja zostają w logu.
  bezpieczny.pathname = bezpieczny.pathname.replace(/(\/ms\/[A-Z]{2}\/vat\/)[^/]+/gi, '$1[ukryto]');
  for (const nazwa of new Set(bezpieczny.searchParams.keys())) {
    if (sekretneParametry.has(nazwa.toLowerCase())) bezpieczny.searchParams.delete(nazwa);
  }
  return bezpieczny.href;
}

/** Identyfikatory z URL mogą wrócić także jako tekst błędu operatora integracji. */
export function ukryjIdentyfikatoryHttp(adres: string, tresc: string): string {
  const url = new URL(adres);
  const identyfikatory = [...url.searchParams]
    .filter(([nazwa]) => ['q[nip_eq]', 'nip_eq', 'requesternumber'].includes(nazwa.toLowerCase()))
    .map(([, wartosc]) => wartosc);
  const vat = url.pathname.match(/\/ms\/([A-Z]{2})\/vat\/([^/]+)/i);
  if (vat) identyfikatory.push(decodeURIComponent(vat[2]), `${vat[1]}${decodeURIComponent(vat[2])}`);
  let wynik = String(tresc);
  for (const wartosc of identyfikatory.filter(Boolean).sort((a, b) => b.length - a.length)) {
    for (const forma of new Set([wartosc, encodeURIComponent(wartosc)])) wynik = wynik.split(forma).join('[ukryto]');
  }
  return wynik;
}

function odstep(odpowiedz: Response, proba: number): number {
  const wartosc = odpowiedz.headers.get('Retry-After')?.trim();
  if (wartosc) {
    if (/^\d+$/.test(wartosc)) return Number(wartosc) * 1000;
    // Nie dopuszczamy luźnego parsera V8 (np. „1.5” czy „-1” jako rok 2001).
    if (/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(wartosc)) {
      const data = Date.parse(wartosc);
      if (Number.isFinite(data)) return Math.max(0, data - Date.now());
    }
  }
  return 2 ** proba * 500;
}

/**
 * Limit na próbę obejmuje także odczyt treści zwróconej Response przez sygnał fetch.
 * Błędy odczytu body po zwrocie odpowiedzi obsługuje klient; http ich nie ponawia.
 */
export function utworzHttp(o: OpcjeHttp = {}): (adres: string, init?: RequestInit) => Promise<Response> {
  const limitCzasuMs = o.limitCzasuMs ?? 30_000;
  const ponowien = o.ponowien ?? 2;
  const maksCzekaniaMs = o.maksCzekaniaMs ?? 60_000;
  for (const [nazwa, wartosc] of Object.entries({ limitCzasuMs, ponowien, maksCzekaniaMs })) {
    if (!Number.isSafeInteger(wartosc) || wartosc < 0 || (nazwa !== 'ponowien' && wartosc > 2_147_483_647)) {
      throw new RangeError(`${nazwa}: wymagana nieujemna całkowita wartość w obsługiwanym zakresie`);
    }
  }
  const fetchImpl = o.fetchImpl ?? fetch;
  const czekaj = o.czekaj;
  const log = o.log ?? console.warn;

  return async (adres, init = {}) => {
    let url: URL;
    try { url = new URL(adres); }
    catch { throw new Error('HTTP: nieprawidłowy adres'); }
    let naglowki: Headers;
    try { naglowki = new Headers(init.headers); }
    catch { throw new Error(`${url.host}: nieprawidłowe nagłówki`); }
    // Nagłówki, klucz i metoda nie mogą zmienić się pomiędzy próbami.
    init = { ...init, headers: naglowki };
    const bezpiecznyAdres = adresDoLogu(url);
    const metoda = (init.method ?? 'GET').toUpperCase();
    const klucz = naglowki.get('Idempotency-Key')?.trim();
    const idempotentne = ['GET', 'HEAD', 'PUT', 'DELETE'].includes(metoda)
      || (['POST', 'PATCH'].includes(metoda) && Boolean(klucz));
    // Strumienie webowe, Node i iteratory są jednorazowe, nawet z kluczem.
    const moznaPonawiac = idempotentne && odtwarzalne(init.body);
    const anulowane = () => {
      const blad = new Error(`${url.host}: żądanie anulowane`);
      blad.name = 'AbortError';
      return metadaneBledu(blad, init.signal?.reason);
    };
    const poczekaj = (ms: number) => new Promise<void>((resolve, reject) => {
      const signal = init.signal;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const zakoncz = (akcja: () => void) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', przerwij);
        akcja();
      };
      const przerwij = () => zakoncz(() => reject(anulowane()));
      if (signal?.aborted) { przerwij(); return; }
      signal?.addEventListener('abort', przerwij, { once: true });
      if (czekaj) Promise.resolve().then(() => czekaj(ms)).then(() => zakoncz(resolve), blad => zakoncz(() => reject(blad)));
      else timer = setTimeout(() => zakoncz(resolve), ms);
    });

    for (let proba = 0; ; proba++) {
      if (init.signal?.aborted) throw anulowane();
      const limit = AbortSignal.timeout(limitCzasuMs);
      const signal = init.signal ? AbortSignal.any([init.signal, limit]) : limit;
      let odpowiedz: Response;
      try {
        odpowiedz = await fetchImpl(adres, { ...init, signal });
      } catch (przyczyna) {
        // Nie logujemy błędu transportu ani cause: mogą zawierać URL i nagłówki.
        const blad = init.signal?.aborted ? anulowane()
          : new Error(`${url.host}: ${limit.aborted ? 'limit czasu' : 'błąd sieci'}`);
        metadaneBledu(blad, limit.aborted ? limit.reason : przyczyna);
        // PRZ-117: sam kod systemowy (już przefiltrowany w metadaneBledu) rozstrzyga DNS czy połączenie.
        const kod = (blad as Error & { code?: string }).code;
        log(`HTTP ${metoda} ${bezpiecznyAdres}: ${blad.message}${kod ? ` (${kod})` : ''}`);
        if (init.signal?.aborted || !moznaPonawiac || proba >= ponowien) throw blad;
        const ms = 2 ** proba * 500;
        if (ms > maksCzekaniaMs) throw blad;
        await poczekaj(ms);
        continue;
      }

      if (odpowiedz.status >= 400) log(`HTTP ${metoda} ${bezpiecznyAdres}: status ${odpowiedz.status}`);
      const przejsciowy = odpowiedz.status === 429 || (odpowiedz.status >= 500 && odpowiedz.status <= 599);
      if (!przejsciowy || !moznaPonawiac || proba >= ponowien) return odpowiedz;
      const ms = odstep(odpowiedz, proba);
      if (ms > maksCzekaniaMs) return odpowiedz;
      // Tylko odrzucane odpowiedzi zwalniamy; ostatnie ciało pozostaje do odczytu.
      void odpowiedz.body?.cancel().catch(() => {});
      await poczekaj(ms);
    }
  };
}
