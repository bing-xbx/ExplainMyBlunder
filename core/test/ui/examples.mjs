import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { headersFor } from './support.mjs';

const web=fileURLToPath(new URL('../../../web/',import.meta.url));
const catalog=JSON.parse(readFileSync(new URL('../../examples/catalog.json',import.meta.url),'utf8'));
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.xml':'application/xml','.txt':'text/plain','.pgn':'application/x-chess-pgn'};
const server=createServer((req,res)=>{
  const path=new URL(req.url,'http://local').pathname;
  let file=resolve(web,'.'+path);
  if(file!==resolve(web)&&!file.startsWith(web)){res.writeHead(403).end();return;}
  if(existsSync(file)&&statSync(file).isDirectory()) file=join(file,'index.html');
  if(!existsSync(file)){res.writeHead(404).end();return;}
  res.writeHead(200,{...headersFor(path),'Content-Type':types[extname(file)]||'application/octet-stream'}).end(readFileSync(file));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base='http://127.0.0.1:'+server.address().port;
const chrome=[process.env.CHROME_PATH,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/google-chrome','/usr/bin/chromium'].find(p=>p&&existsSync(p));
let browser;
try {
  browser=await puppeteer.launch({executablePath:chrome,headless:true,args:process.env.CI?['--no-sandbox']:[]});
  for(const example of catalog){
    const path='/examples/'+example.slug+'/';
    for(const width of [1200,390]){
      const page=await browser.newPage();
      const errors=[],requests=[];
      page.on('pageerror',e=>errors.push(e.message));
      page.on('request',r=>requests.push(r.url()));
      await page.setViewport({width,height:1000,deviceScaleFactor:1});
      await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
      const response=await page.goto(base+path);
      assert(!response.headers()['x-robots-tag'],'Examples must be indexable');
      assert(response.headers()['content-security-policy'].includes("object-src 'none'"));
      await page.waitForFunction(()=>document.querySelector('#load-status').textContent.startsWith('Use the buttons'));
      assert.equal(await page.$$eval('.cg-wrap cg-board',els=>els.length),2);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No horizontal overflow');
      for(let i=0;i<2;i++){
        const panel='[data-line="'+i+'"]';
        await page.click(panel+' [data-action="next"]');
        assert.equal(await page.$eval(panel+' [aria-pressed="true"]',e=>e.textContent),example.lines[i][0]);
        await page.focus(panel+' [data-ply="1"]');
        await page.keyboard.press('ArrowRight');
        assert.equal(await page.$eval(panel+' [aria-pressed="true"]',e=>e.textContent),example.lines[i][1]);
        await page.click(panel+' [data-action="end"]');
        const caption=await page.$eval(panel+' .position',e=>e.textContent);
        assert(caption.includes('White '+example.expected[i][0]+', Black '+example.expected[i][1]));
        assert.equal(await page.$eval(panel+' [data-action="next"]',e=>e.disabled),true);
        assert.equal(await page.$$eval(panel+' square.check',els=>els.length)>0,example.mate[i]);
        if(example.mate[i]){
          assert(await page.$eval(panel+' square.check',el=>{
            const check=el.getBoundingClientRect();
            const king=el.parentElement.querySelector('piece.black.king').getBoundingClientRect();
            return Math.abs(check.x-king.x)<1 && Math.abs(check.y-king.y)<1;
          }), 'Check marker must identify the checked king');
        }
      }
      if(width===1200 && process.argv.includes('--screenshots')){
        const style=await page.addStyleTag({content:'.comparison{width:1200px;height:630px;padding:24px;background:#171b19}.comparison .board-shell{max-width:360px;margin:auto}.comparison .controls,.comparison .moves{display:none}.comparison .position{min-height:0}'});
        await (await page.$('.comparison')).screenshot({path:join(web,'examples',example.slug,'preview.png')});
        await style.evaluate(el=>el.remove());
      }
      for(let i=0;i<2;i++){
        await page.click('[data-line="'+i+'"] [data-action="start"]');
        assert.equal(await page.$eval('[data-line="'+i+'"] [data-action="prev"]',e=>e.disabled),true);
      }
      assert(!requests.some(url=>/stockfish|core\.js|\/v1\//.test(url)),'Examples must not start an engine or paid service');
      assert.deepEqual(errors,[]);
      await page.close();
    }
    const page=await browser.newPage();
    await page.setJavaScriptEnabled(false);
    await page.goto(base+path);
    assert.equal(await page.$$eval('.static-board svg',els=>els.length),2);
    assert((await page.$eval('.intro',e=>e.textContent)).includes(example.summary));
    assert.equal(await page.$$eval('.moves button',els=>els.length),example.lines.flat().length);
    await page.close();
    const failed=await browser.newPage();
    await failed.setRequestInterception(true);
    failed.on('request',r=>r.url().endsWith('positions.json')?r.abort():r.continue());
    await failed.goto(base+path);
    await failed.waitForFunction(()=>document.querySelector('#load-status').textContent.includes('could not load'));
    assert.equal(await failed.$$eval('.static-board:not([hidden])',els=>els.length),2);
    await failed.close();
    console.log('ok: '+example.slug+' desktop, phone, keyboard, static and failed-fetch fallback');
  }
  for(const width of [1200,390]){
    const page=await browser.newPage(); await page.setViewport({width,height:1000});
    await page.goto(base+'/examples/');
    assert.equal(await page.$$eval('.cards article',els=>els.length),3);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert(await page.$$eval('.cards img',els=>els.every(e=>e.complete&&e.naturalWidth>0)));
    if(process.argv.includes('--screenshots')) await page.screenshot({path:'/tmp/emb-examples-'+width+'.png',fullPage:true});
    await page.close();
  }
  for(const path of ['/examples/',...catalog.map(e=>'/examples/'+e.slug+'/')]){
    const html=await (await fetch(base+path)).text();
    for(const [,href] of html.matchAll(/(?:href|src)="([^"]+)"/g)){
      if(href.startsWith('#')||href.startsWith('data:')||href.startsWith('https:')) continue;
      const response=await fetch(new URL(href,base+path));
      assert(response.ok,'Broken link: '+href);
    }
    assert(html.includes('rel="canonical"'));
    assert(html.includes('property="og:image"'));
  }
  for(const path of ['/','/pay.html']) assert.equal(headersFor(path)['x-robots-tag'],'noindex');
  assert(!(await fetch(base+'/sitemap.xml')).headers.get('x-robots-tag'));
  console.log('ok: index images, links, metadata, sitemap and scoped discovery headers');
} finally {
  if(browser) await browser.close();
  server.close();
}
