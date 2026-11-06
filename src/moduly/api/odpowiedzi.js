/** Wspólny format błędów i list API v1. */
export function blad(reply, status, kod, powod) {
  return reply.code(status).send({ kod, powod });
}

export function czytajStronicowanie(query) {
  const tekstPo = query.po === undefined ? '0' : query.po;
  const tekstIle = query.ile === undefined ? '100' : query.ile;
  const po = Number(tekstPo);
  const ile = Number(tekstIle);
  if (typeof tekstPo !== 'string' || !/^\d+$/.test(tekstPo) || !Number.isSafeInteger(po) || po < 0) {
    throw Object.assign(new Error('Parametr po musi być nieujemną bezpieczną liczbą całkowitą zapisaną cyframi.'), {
      statusCode: 400, kod: 'stronicowanie',
    });
  }
  if (typeof tekstIle !== 'string' || !/^\d+$/.test(tekstIle) || !Number.isInteger(ile) || ile < 1 || ile > 200) {
    throw Object.assign(new Error('Parametr ile musi być liczbą całkowitą od 1 do 200.'), {
      statusCode: 400, kod: 'stronicowanie',
    });
  }
  return { po, ile };
}

export function strona(pozycje, ile) {
  return { pozycje, nastepny: pozycje.length === ile ? pozycje.at(-1).id : null };
}
