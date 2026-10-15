import {createHash} from 'node:crypto';
// Allegro public.v1, checked 2026-10-13: declaration size <= 5242880.
// Five files / 20 MiB total are explicit OMS limits, not claimed API limits.
export const MAKS_PLIK = 5 * 1024 * 1024;
export const MAKS_RAZEM = 20 * 1024 * 1024;
export const MAKS_PLIKOW = 5;
export function sprawdzNazwe(nazwa) {
  if(typeof nazwa!=='string'||!nazwa.trim()||nazwa.length>255||/[\x00-\x1f\x7f\\/:]/.test(nazwa)||nazwa==='.'||nazwa==='..')throw Error('Nieprawidłowa nazwa załącznika. Użyj nazwy bez ścieżki i znaków sterujących.');
  return nazwa;
}
export function sprawdzPlik(nazwa, bajty) {
  sprawdzNazwe(nazwa);
  if(!Buffer.isBuffer(bajty)||!bajty.length||bajty.length>MAKS_PLIK)throw Error('Załącznik musi mieć rozmiar od 1 B do 5 MiB.');
  const start=bajty.subarray(0,8), ascii=start.toString('ascii');
  let mime, rozszerzenia;
  if(ascii.startsWith('%PDF-')){mime='application/pdf';rozszerzenia=['pdf'];}
  else if(start.equals(Buffer.from([137,80,78,71,13,10,26,10]))){mime='image/png';rozszerzenia=['png'];}
  else if(ascii.startsWith('GIF87a')||ascii.startsWith('GIF89a')){mime='image/gif';rozszerzenia=['gif'];}
  else if(start[0]===255&&start[1]===216&&start[2]===255){mime='image/jpeg';rozszerzenia=['jpg','jpeg'];}
  else if(ascii.startsWith('BM')){mime='image/bmp';rozszerzenia=['bmp'];}
  else if(start.subarray(0,4).equals(Buffer.from([73,73,42,0]))||start.subarray(0,4).equals(Buffer.from([77,77,0,42]))){mime='image/tiff';rozszerzenia=['tif','tiff'];}
  const extension=nazwa.split('.').at(-1).toLowerCase();
  if(!mime||!rozszerzenia.includes(extension))throw Error('Dozwolone są pliki PDF, PNG, GIF, BMP, TIFF i JPEG z rozszerzeniem zgodnym z zawartością.');
  return {nazwa,mime,rozmiar:bajty.length,sha256:createHash('sha256').update(bajty).digest('hex'),bajty};
}
export async function odczytajOdpowiedz(req) {
  if(!req.isMultipart())return {tresc:String(req.body?.tresc??''),potwierdzam:req.body?.potwierdzam,pliki:[]};
  const fields={};const pliki=[];let razem=0;
  try { for await(const part of req.parts()) {
    if(part.type==='file') {
      if(part.fieldname!=='zalaczniki')throw Error('Nieznane pole pliku.');
      const bajty=await part.toBuffer();
      if(part.file.truncated)throw Error('Załącznik przekracza limit 5 MiB.');
      if(!part.filename&&!bajty.length)continue;
      const plik=sprawdzPlik(part.filename,bajty);razem+=plik.rozmiar;
      if(razem>MAKS_RAZEM)throw Error('Limit OMS: 20 MiB załączników w jednej wiadomości.');
      pliki.push(plik);
      if(pliki.length>MAKS_PLIKOW)throw Error('Limit OMS: 5 załączników w jednej wiadomości.');
    } else {
      if(!['tresc','potwierdzam'].includes(part.fieldname)||Object.hasOwn(fields,part.fieldname)||part.valueTruncated)throw Error('Nieprawidłowe pola odpowiedzi.');
      fields[part.fieldname]=part.value;
    }
  }
  } catch(error) { error.szkic=String(fields.tresc??'');throw error; }
  return {tresc:String(fields.tresc??''),potwierdzam:fields.potwierdzam,pliki};
}
