// Generate engine-free demonstrations from selected public-game continuations.
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
const css = readFileSync(join(web, 'vendor/chessground/chessground.cburnett.css'), 'utf8');
const pieces = new Map([...css.matchAll(/piece\.(\w+)\.(\w+)\s*\{\s*background-image: url\('([^']+)'\)/g)].map(m => [m[2]+'-'+m[1],m[3]]));
assert.equal(pieces.size,12);
function material(pos) {
  const totals = { white:0, black:0 };
  for (const [,piece] of pos.board) totals[piece.color] += weights[piece.role];
  return [totals.white,totals.black];
}
function boardSvg(fen) {
  const pos = Chess.fromSetup(parseFen(fen).unwrap()).unwrap();
  let svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" role="img" aria-label="Starting position, Black at the bottom">';
  for(let i=0;i<64;i++){
    const x=(7-i%8)*50, y=Math.floor(i/8)*50;
    svg += '<rect x="'+x+'" y="'+y+'" width="50" height="50" fill="'+((i%8+Math.floor(i/8))%2?'#f0d9b5':'#b58863')+'"/>';
    const piece=pos.board.get(i);
    if(piece) svg += '<image x="'+x+'" y="'+y+'" width="50" height="50" href="'+pieces.get(piece.color+'-'+piece.role)+'"/>';
  }
  return svg+'</svg>';
}
function head(title,description,path,image) {
  return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>'+esc(title)+' · ExplainMyBlunder</title><meta name="description" content="'+esc(description)+'"><link rel="canonical" href="'+origin+path+'"><meta property="og:type" content="website"><meta property="og:title" content="'+esc(title)+'"><meta property="og:description" content="'+esc(description)+'"><meta property="og:url" content="'+origin+path+'"><meta property="og:image" content="'+origin+image+'"><meta property="og:image:alt" content="Two chess boards comparing the played move with a better continuation"><meta name="twitter:card" content="summary_large_image"><link rel="icon" href="/icon-192.png"><link rel="stylesheet" href="/examples/examples.css"><link rel="stylesheet" href="/vendor/chessground/chessground.base.css"><link rel="stylesheet" href="/vendor/chessground/chessground.brown.css"><link rel="stylesheet" href="/vendor/chessground/chessground.cburnett.css"></head><body><a class="skip" href="#main">Skip to content</a><header><a class="brand" href="/examples/">ExplainMyBlunder <span> / examples</span></a><a href="/">Open the app ↗</a></header>';
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
  const lines=example.lines.map((sans,lineIndex)=>{
    const recorded=card[lineIndex===0?'lineA':'lineB'].plies;
    assert.deepEqual(sans,recorded.map(p=>p.san));
    const pos=Chess.fromSetup(parseFen(example.fen).unwrap()).unwrap();
    const frames=[{fen:example.fen,san:'Before the move',material:material(pos),check:pos.isCheck()}];
    for(const [ply,san] of sans.entries()){
      const move=parseSan(pos,san); assert(move && pos.isLegal(move),'Illegal move: '+example.slug+' '+san);
      assert.equal(makeSan(pos,move),san);
      // Fixture coordinates use king destinations for castling, as the board expects.
      const lastMove=recorded[ply].lastMove;
      pos.play(move);
      assert.equal(makeFen(pos.toSetup()).split(' ').slice(0,3).join(' '), recorded[ply].fen.split(' ').slice(0,3).join(' '), 'Fixture position differs after '+san);
      frames.push({fen:makeFen(pos.toSetup()),san,lastMove,material:material(pos),check:pos.isCheck()});
    }
    assert.deepEqual(material(pos),example.expected[lineIndex],'Wrong endpoint material: '+example.slug);
    assert.equal(pos.isCheckmate(),example.mate[lineIndex],'Wrong mate claim: '+example.slug);
    return frames;
  });
  const dir=join(web,'examples',example.slug); mkdirSync(dir,{recursive:true});
  copyFileSync(join(core,'test/public-games',example.game+'.pgn'),join(dir,'game.pgn'));
  writeFileSync(join(dir,'positions.json'),JSON.stringify({orientation:example.orientation,lines})+'\n');
  const panels=lines.map((frames,i)=>{
    const name=i?'better':'played';
    return '<section class="line '+name+'" aria-labelledby="line-'+i+'" data-line="'+i+'"><div class="line-heading"><span>'+(i?'Better move':'Played move')+'</span><h2 id="line-'+i+'">'+esc(frames[1].san)+'</h2><p>'+esc(i?example.b:example.a)+'</p></div><div class="board-shell"><div class="static-board">'+boardSvg(example.fen)+'</div><div class="cg-wrap" hidden aria-label="'+name+' line chess board"></div></div><p class="position" aria-live="polite">Before the move · Black to play</p><div class="controls" hidden><button data-action="start" aria-label="Start of '+name+' line">Start</button><button data-action="prev" aria-label="Previous move in '+name+' line">←</button><button data-action="next" aria-label="Next move in '+name+' line">→</button><button data-action="end" aria-label="End of '+name+' line">End</button></div><ol class="moves">'+frames.slice(1).map((f,j)=>'<li><button data-ply="'+(j+1)+'" disabled>'+esc(f.san)+'</button></li>').join('')+'</ol></section>';
  }).join('');
  const path='/examples/'+example.slug+'/'; urls.push(path);
  const html=head(example.title,example.description,path,path+'preview.png')+
    '<main id="main"><nav aria-label="Breadcrumb"><a href="/examples/">Examples</a> / '+esc(example.players)+'</nav><p class="eyebrow">Two moves. Two different outcomes.</p><h1>'+esc(example.title)+'</h1><p class="intro">'+esc(example.summary)+'</p><p class="hint">Black is at the bottom. Step through either line to see what changes.</p><div class="comparison">'+panels+'</div><p id="load-status" role="status">Interactive controls load automatically. The complete move sequences are shown above.</p><section class="explanation"><h2>What to notice</h2><p>'+esc(example.detail)+'</p><p>These are recorded engine continuations, not a claim that every reply is forced. Material totals count pawns as 1, knights and bishops as 3, rooks as 5, and queens as 9.</p></section><aside class="cta"><h2>Try it with your own game</h2><p>Paste a PGN or load your Lichess or chess.com games. See both continuations and explore moves on the board.</p><a class="button" href="/">Review your game →</a></aside><section class="source"><h2>About this position</h2><p>'+esc(example.players)+' · '+esc(example.event)+' · '+esc(example.date)+'. Position before ply '+example.ply+'.</p><p><a href="game.pgn">Download the source game (PGN)</a>. Continuations come from the public analysis fixtures at '+example.nodes.toLocaleString('en-US')+' nodes per position. Engine build was not recorded with these fixtures; different searches may prefer different continuations.</p><details><summary>Starting position (FEN)</summary><code>'+esc(example.fen)+'</code></details></section></main><script type="module" src="/examples/examples.js"></script>'+footer;
  writeFileSync(join(dir,'index.html'),html);
}
const index=head('Understand a chess mistake in a few moves','Three playable examples: compare a missed chance, a tempting queen capture, and an undefended pawn.','/examples/','/examples/'+catalog[1].slug+'/preview.png')+
  '<main id="main"><p class="eyebrow">See the reason on the board</p><h1>The engine says it’s a mistake.<br>What actually changes?</h1><p class="intro">Compare the move played with a better continuation. Step through both boards, without an account or a wait for analysis.</p><div class="cards">'+catalog.map(e=>'<article><a href="/examples/'+e.slug+'/"><img src="/examples/'+e.slug+'/preview.png" alt="Played and better continuations from '+esc(e.players)+'" width="1200" height="630"><h2>'+esc(e.title)+'</h2></a><p>'+esc(e.description)+'</p><a class="text-link" href="/examples/'+e.slug+'/">Explore both lines →</a></article>').join('')+'</div><aside class="cta"><h2>Your game has a story, too.</h2><p>Free on-board explanations, powered by Stockfish. Your reviews stay on your device.</p><a class="button" href="/">Review your game →</a></aside></main>'+footer;
writeFileSync(join(web,'examples/index.html'),index);
writeFileSync(join(web,'sitemap.xml'),'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+urls.map(url=>'<url><loc>'+origin+url+'</loc></url>').join('')+'</urlset>\n');
writeFileSync(join(web,'robots.txt'),'User-agent: *\nAllow: /\nSitemap: '+origin+'/sitemap.xml\n');
console.log('Built and validated '+catalog.length+' public chess examples');
