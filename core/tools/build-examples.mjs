// Generate walkthroughs and in-app examples from selected public reviews.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { Chess } from 'chessops/chess';
import { parseFen, makeFen } from 'chessops/fen';
import { parseSan, makeSan } from 'chessops/san';

const core = fileURLToPath(new URL('../', import.meta.url));
const web = join(core, '../web');
const origin = 'https://explainmyblunder.pages.dev';
const catalog = JSON.parse(readFileSync(join(core, 'examples/catalog.json'), 'utf8'));
const reviews = JSON.parse(readFileSync(join(core, 'test/ui/reviews-public.json'), 'utf8'));
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const weights = { pawn:1, knight:3, bishop:3, rook:5, queen:9, king:0 };
function material(pos) {
  const totals = { white:0, black:0 };
  for (const [,piece] of pos.board) totals[piece.color] += weights[piece.role];
  return [totals.white,totals.black];
}
function head(title,description,path,image) {
  return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>'+esc(title)+' · ExplainMyBlunder</title><meta name="description" content="'+esc(description)+'"><link rel="canonical" href="'+origin+path+'"><meta property="og:type" content="website"><meta property="og:title" content="'+esc(title)+'"><meta property="og:description" content="'+esc(description)+'"><meta property="og:url" content="'+origin+path+'"><meta property="og:image" content="'+origin+image+'"><meta property="og:image:alt" content="The actual ExplainMyBlunder review interface"><meta name="twitter:card" content="summary_large_image"><link rel="icon" href="/icon-192.png"><link rel="stylesheet" href="/examples/examples.css"></head><body><a class="skip" href="#main">Skip to content</a><header><a class="brand" href="/examples/">ExplainMyBlunder <span> / examples</span></a><a href="/">Open the app ↗</a></header>';
}
const footer='<footer>Free, open source, and runs on your device. <a href="/">Review your game</a> · <a href="/examples/">All examples</a></footer></body></html>\n';
const urls=['/examples/'];
const seen=new Set();
for(const example of catalog){
  assert.match(example.slug,/^[a-z0-9-]+$/);
  assert(!seen.has(example.slug),'Duplicate example slug'); seen.add(example.slug);
  const review=reviews.find(r=>r.id==='public-'+example.game);
  const card=review?.moments.find(m=>m.ply===example.ply)?.card;
  assert(card,'Example must come from a public fixture');
  assert.equal(card.start.fen,example.fen);
  example.lines.forEach((sans,lineIndex)=>{
    const recorded=card[lineIndex===0?'lineA':'lineB'].plies;
    assert.deepEqual(sans,recorded.map(p=>p.san));
    const pos=Chess.fromSetup(parseFen(example.fen).unwrap()).unwrap();
    for(const [ply,san] of sans.entries()){
      const move=parseSan(pos,san); assert(move && pos.isLegal(move),'Illegal move: '+example.slug+' '+san);
      assert.equal(makeSan(pos,move),san);
      pos.play(move);
      assert.equal(makeFen(pos.toSetup()).split(' ').slice(0,3).join(' '), recorded[ply].fen.split(' ').slice(0,3).join(' '), 'Fixture position differs after '+san);
    }
    assert.deepEqual(material(pos),example.expected[lineIndex],'Wrong endpoint material: '+example.slug);
    assert.equal(pos.isCheckmate(),example.mate[lineIndex],'Wrong mate claim: '+example.slug);
  });
  const dir=join(web,'examples',example.slug); mkdirSync(dir,{recursive:true});
  copyFileSync(join(core,'test/public-games',example.game+'.pgn'),join(dir,'game.pgn'));
  // Preserve the actual app card, annotations, variations, and game records.
  // Other moments are omitted: this demo deliberately highlights one explanation.
  const moment=review.moments.find(m=>m.ply===example.ply);
  assert(moment.san!==moment.bestSan, 'A demo must compare distinct moves');
  writeFileSync(join(dir,'review.json'),JSON.stringify({...review,moments:[moment]})+'\n');
  const path='/examples/'+example.slug+'/'; urls.push(path);
  const app='/?example='+example.slug;
  const html=head(example.title,example.description,path,path+'preview.png')+
    '<main id="main"><nav aria-label="Breadcrumb"><a href="/examples/">Examples</a> / '+esc(example.players)+'</nav><p class="eyebrow">Try the real app</p><h1>'+esc(example.title)+'</h1><p class="intro">'+esc(example.description)+'</p><a class="button" href="'+app+'">Open this review in the app →</a><p>'+esc(example.guide)+'</p><a href="'+app+'"><img class="app-preview" src="preview.png" alt="Screenshot of the actual ExplainMyBlunder app: '+esc(example.title)+'"></a><section class="explanation"><h2>What you can do</h2><p>The example opens a precomputed public game at one explained mistake. Use the normal move list, on-board annotations, captions, and Compare button. Drag a piece with “Explain moves I try” enabled to get a fresh explanation from Stockfish on your device.</p><p>The review opens without waiting for a full game analysis. Live engine evaluation and explanations of moves you try still take computation time.</p></section><section class="source"><h2>Source game</h2><p>'+esc(example.players)+' · '+esc(example.event)+' · '+esc(example.date)+'.</p><p><a href="game.pgn">Download the game (PGN)</a>. The selected explanation comes unchanged from the app’s public review fixtures, recorded at '+example.nodes.toLocaleString('en-US')+' nodes per position. Only this one moment is included in the demonstration; your saved reviews are not changed.</p></section></main>'+footer;
  writeFileSync(join(dir,'index.html'),html);
}
writeFileSync(join(web,'examples/catalog.json'),JSON.stringify(catalog.map(({slug,ply,title,guide})=>({slug,ply,title,guide})))+'\n');
const index=head('Try ExplainMyBlunder with a real game','Explore the app’s annotated explanations, Compare view, and explanations of moves you try.','/examples/','/examples/the-undefended-pawn/preview.png')+
  '<main id="main"><p class="eyebrow">Real games. The actual app.</p><h1>See how ExplainMyBlunder<br>explains a mistake.</h1><p class="intro">Open a public game directly at an explained move. Follow its annotated lines, compare the outcomes, or try your own move. No account or game upload needed.</p><div class="cards">'+catalog.map(e=>'<article><a href="/?example='+e.slug+'"><img src="/examples/'+e.slug+'/preview.png" alt="ExplainMyBlunder app: '+esc(e.title)+'"><h2>'+esc(e.title)+'</h2></a><p>'+esc(e.description)+'</p><a class="text-link" href="/?example='+e.slug+'">Open in the app →</a><p><a href="/examples/'+e.slug+'/">Walkthrough and source game</a></p></article>').join('')+'</div><aside class="cta"><h2>Review your own game</h2><p>Load your Lichess or chess.com games, or paste a PGN.</p><a class="button" href="/">Open ExplainMyBlunder →</a></aside></main>'+footer;
writeFileSync(join(web,'examples/index.html'),index);
writeFileSync(join(web,'sitemap.xml'),'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+urls.map(url=>'<url><loc>'+origin+url+'</loc></url>').join('')+'</urlset>\n');
writeFileSync(join(web,'robots.txt'),'User-agent: *\nAllow: /\nSitemap: '+origin+'/sitemap.xml\n');
console.log('Built and validated '+catalog.length+' in-app examples');
