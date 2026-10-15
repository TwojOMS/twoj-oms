import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
const src = fileURLToPath(new URL('../../', import.meta.url));
export function katalogiWidokow() {
  const moduly=join(src,'moduly');
  return [join(src,'core/web/widoki'), ...readdirSync(moduly,{withFileTypes:true}).filter(d=>d.isDirectory())
    .map(d=>join(moduly,d.name,'widoki')).filter(d=>existsSync(d))];
}
export function sciezkaWidoku(page) {
  if(page.startsWith('core/')||page.startsWith('moduly/'))return page;
  if(page.includes('..')||page.startsWith('/')||page.includes('\\'))throw new Error('Niedozwolona ścieżka widoku');
  const found=katalogiWidokow().map(d=>join(d,page)).filter(p=>existsSync(p));
  if(found.length!==1)throw new Error(`Widok ${page}: oczekiwano jednej definicji, znaleziono ${found.length}`);
  return relative(src,found[0]).replaceAll('\\','/');
}
