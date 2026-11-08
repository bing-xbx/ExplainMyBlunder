import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { headersFor } from './support.mjs';

const web=fileURLToPath(new URL('../../../web/',import.meta.url));
const catalog=JSON.parse(readFileSync(new URL('../../examples/catalog.json',import.meta.url),'utf8'));
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.xml':'application/xml','.txt':'text/plain','.pgn':'application/x-chess-pgn','.wasm':'application/wasm','.webmanifest':'application/manifest+json'};
const server=createServer((req,res)=>{
  const path=new URL(req.url,'http://local').pathname;
  let file=resolve(web,'.'+path);
  if(file!==resolve(web)&&!file.startsWith(web)){res.writeHead(403).end();return;}
  if(existsSync(file)&&statSync(file).isDirectory()) file=join(file,'index.html');
  if(!existsSync(file)){res.writeHead(404).end();return;}
  if(path==='/config.json'){res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({backend:null,upgrade_url:null,github_url:null}));return;}
  res.writeHead(200,{...headersFor(path),'Content-Type':types[extname(file)]||'application/octet-stream'}).end(readFileSync(file));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base='http://127.0.0.1:'+server.address().port;
const chrome=[process.env.CHROME_PATH,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/google-chrome','/usr/bin/chromium'].find(p=>p&&existsSync(p));
let browser;
try {
  browser=await puppeteer.launch({executablePath:chrome,headless:true,args:process.env.CI?['--no-sandbox']:[]});

  for(const example of catalog){
    for(const width of [1440,390]){
      const context=await browser.createBrowserContext();
      const page=await context.newPage();
      await page.setViewport({width,height:1000,deviceScaleFactor:1});
      const errors=[],requests=[];
      page.on('pageerror',e=>errors.push(e.message));
      page.on('request',r=>requests.push(r.url()));
      // A separate saved review must survive opening and exploring a demo.
      await page.goto(base);
      await page.waitForFunction(()=>document.body.classList.contains('local'));
      const seed=JSON.parse(readFileSync(new URL('reviews-public.json',import.meta.url),'utf8'))[0];
      await page.evaluate(async r=>(await import('/core.js')).importReviews([r]),seed);
      const savedBefore=await page.evaluate(async id=>(await import('/core.js')).localApi('/api/review',{id}),seed.id);
      await page.goto(base+'/?example='+example.slug);
      await page.waitForFunction(()=>!document.getElementById('example-guide').hidden && document.querySelector('#moves .comment'));
      const panel=width<820?'#explain':'#moves';
      const review=JSON.parse(readFileSync(join(web,'examples',example.slug,'review.json'),'utf8'));
      const card=review.moments[0].card;
      assert((await page.$eval(panel,e=>e.textContent)).includes(card.summary),'The app must show the unchanged review explanation');
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No horizontal overflow');
      assert.equal(await page.$eval('#whatif',e=>e.checked),true);
      assert.equal(await page.$$eval('.comparison',els=>els.length),0,'No separate demonstration renderer');

      // Follow the actual app line: it starts with the reply, since the
      // played move is already the current position on the main board.
      if(example.slug==='the-undefended-pawn'){
        assert((await page.$eval('#board',e=>e.innerHTML)).includes('hanging'),'Actual board annotation is visible');
      }
      await page.click(panel+' .v-after .mv');
      await page.waitForFunction(()=>!document.getElementById('caption').hidden);
      assert(await page.$$eval('#board svg',els=>els.length)>0);
      assert((await page.$eval('#caption',e=>e.textContent)).includes(card.lineA.plies[1].caption));
      if(card.lineA.plies.length>2){
        await page.click('[data-nav="next"]');
        assert((await page.$eval('#caption',e=>e.textContent)).includes(card.lineA.plies[2].caption));
      }
      await page.click(panel+' .v-best .mv');
      assert((await page.$eval('#context',e=>e.textContent)).length>0);
      await page.click(panel+' .card-actions button');
      await page.waitForFunction(()=>!document.getElementById('compare').hidden);
      assert.equal(await page.$$eval('#compare cg-board',els=>els.length),2);
      assert((await page.$eval('#cmpAcap',e=>e.textContent)).includes(review.moments[0].san));
      assert((await page.$eval('#cmpBcap',e=>e.textContent)).includes(review.moments[0].bestSan));
      if(example.slug==='the-queen-is-not-free'){
        await page.waitForFunction(()=>{
          const check=document.querySelector('#cmpA square.check')?.getBoundingClientRect();
          const king=document.querySelector('#cmpA piece.black.king')?.getBoundingClientRect();
          return check && king && Math.abs(check.x-king.x)<1 && Math.abs(check.y-king.y)<1;
        });
      }


      if(width===1440 && process.argv.includes('--screenshots') && example.slug==='missed-winning-chance'){
        await page.$eval('main',e=>e.scrollIntoView());
        await page.waitForFunction(()=>!document.querySelector('piece.anim, piece.fading'));
        await page.waitForFunction(()=>document.getElementById('score').textContent.trim()!=='…');
        await page.screenshot({path:join(web,'examples',example.slug,'preview.png')});
      }
      await page.click('#close-compare');
      // Reopen the selected moment before trying another move.
      await page.goto(base+'/?example='+example.slug);
      await page.waitForFunction(()=>!document.getElementById('example-guide').hidden);
      if(example.slug==='the-queen-is-not-free'){
        await page.click('[data-nav="prev"]');
        await page.$eval('#board',e=>e.scrollIntoView({block:'center'}));
        const box=await page.$eval('#board',e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width};});
        // Black orientation: b8 -> c6.
        const from={x:box.x+6.5*box.w/8,y:box.y+7.5*box.w/8};
        const to={x:box.x+5.5*box.w/8,y:box.y+5.5*box.w/8};
        await page.mouse.move(from.x,from.y); await page.mouse.down();
        await page.mouse.move(to.x,to.y,{steps:12}); await page.mouse.up();
        await page.waitForFunction(()=>document.querySelector('#moves .mv.user')?.textContent.includes('Nc6'));
        await page.waitForFunction(()=>!document.getElementById('progress').textContent.includes('Explaining') &&
          [...document.querySelectorAll('#moves .comment')].some(e=>e.textContent.includes('What if')&&e.querySelector('.v-best')),{timeout:120000});
        assert(!(await page.$eval('#error',e=>e.textContent)),'Real what-if analysis must succeed');
      }
      if(width===1440 && process.argv.includes('--screenshots') && example.slug!=='missed-winning-chance'){
        if(example.slug==='the-queen-is-not-free') await page.$eval('#moves .mv.user',e=>e.scrollIntoView({block:'center'}));
        await page.$eval('main',e=>e.scrollIntoView());
        await page.waitForFunction(()=>!document.querySelector('piece.anim, piece.fading'));
        await page.waitForFunction(()=>document.getElementById('score').textContent.trim()!=='…');
        await page.screenshot({path:join(web,'examples',example.slug,'preview.png')});
      }
      const savedReview=await page.evaluate(async id=>(await import('/core.js')).localApi('/api/review',{id}),seed.id);
      assert.deepEqual(savedReview,savedBefore,'Saved review content must be unchanged');
      const saved=await page.evaluate(async()=> (await import('/core.js')).localApi('/api/reviews',{}));
      assert.deepEqual(saved.reviews.map(r=>r.id),[seed.id],'Demo must not replace or add saved reviews');
      assert(!requests.some(url=>url.includes('/api/review/start')),'No full game analysis required');
      if(width<820) await page.click('#sheet-tabs [data-sheet="games"]');
      else await page.click('#sync');
      await page.click('#mygames-list .mg-row.reviewed');
      await page.waitForFunction(()=>document.getElementById('example-guide').hidden && !new URLSearchParams(location.search).has('example'));
      assert.deepEqual(errors,[]);
      await context.close();
    }
    console.log('ok: '+example.slug+' uses real review UI, variations, Compare and saved-review isolation');
  }
  const page=await browser.newPage();
  for(const path of ['/examples/',...catalog.map(e=>'/examples/'+e.slug+'/')]){
    const response=await page.goto(base+path);
    assert(!response.headers()['x-robots-tag']);
    assert.equal(await page.$$eval('.comparison,.cg-wrap',els=>els.length),0);
    assert(await page.$('a[href^="/?example="]'),'Walkthrough links to the real app');
    assert(await page.$$eval('img',els=>els.every(e=>e.complete&&e.naturalWidth>0)));
  }
  // Invalid selections and failed review downloads leave a usable app and an error.
  await page.goto(base+'/?example=not-an-example');
  await page.waitForFunction(()=>document.getElementById('error').textContent.includes('not found'));
  assert(await page.$('#board cg-board'));
  await page.setRequestInterception(true);
  page.on('request',r=>r.url().endsWith('/review.json')?r.respond({status:200,contentType:'application/json',body:'{"id":"invalid"}'}):r.continue());
  await page.goto(base+'/?example='+catalog[0].slug);
  await page.waitForFunction(()=>document.getElementById('error').textContent.includes('not valid'));
  assert.equal(await page.$eval('#example-guide',e=>e.hidden),true);
  await page.close();
  console.log('ok: discovery pages link to the app; unknown and malformed examples fail safely');
} finally {
  if(browser) await browser.close();
  server.close();
}
