import { Chessground } from '/vendor/chessground/chessground.min.js';

const status = document.querySelector('#load-status');
try {
  const response = await fetch('positions.json');
  if (!response.ok) throw new Error('Positions unavailable');
  const data = await response.json();
  document.querySelectorAll('[data-line]').forEach(panel => {
    const frames = data.lines[Number(panel.dataset.line)];
    let ply = 0;
    const element = panel.querySelector('.cg-wrap');
    element.hidden = false;
    const board = Chessground(element, { fen: frames[0].fen, orientation: data.orientation, turnColor: frames[0].fen.split(' ')[1] === 'w' ? 'white' : 'black', viewOnly: true,
      coordinates: true, animation: { enabled: !matchMedia('(prefers-reduced-motion: reduce)').matches },
      drawable: { enabled: false, visible: true } });
    panel.querySelector('.static-board').hidden = true;
    panel.querySelector('.controls').hidden = false;
    panel.querySelectorAll('[data-ply]').forEach(button => button.disabled = false);
    function show(next) {
      ply = Math.max(0, Math.min(frames.length - 1, next));
      const frame = frames[ply];
      board.set({ fen: frame.fen, turnColor: frame.fen.split(' ')[1] === 'w' ? 'white' : 'black', lastMove: frame.lastMove || [], check: frame.check });
      panel.querySelector('.position').textContent = (ply ? ply+'/'+(frames.length-1)+' · '+frame.san : 'Before the move')+' · Material: White '+frame.material[0]+', Black '+frame.material[1];
      for (const button of panel.querySelectorAll('[data-ply]')) button.setAttribute('aria-pressed', String(Number(button.dataset.ply) === ply));
      for (const action of ['start','prev']) panel.querySelector('[data-action="'+action+'"]').disabled = ply === 0;
      for (const action of ['end','next']) panel.querySelector('[data-action="'+action+'"]').disabled = ply === frames.length - 1;
    }
    panel.addEventListener('click', event => {
      const button = event.target.closest('button');
      if (!button) return;
      if (button.dataset.ply) show(Number(button.dataset.ply));
      else if (button.dataset.action) show({start:0,prev:ply-1,next:ply+1,end:frames.length-1}[button.dataset.action]);
    });
    panel.addEventListener('keydown', event => {
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault(); show(ply + (event.key === 'ArrowRight' ? 1 : -1));
      }
    });
    show(0);
  });
  status.textContent = 'Use the buttons or focus a move and press ← / → to explore its line.';
} catch {
  status.textContent = 'The interactive boards could not load. You can still read both move sequences, or reload to try again.';
}
