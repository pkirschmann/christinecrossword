'use strict';

const PUZZLE_URL = new URLSearchParams(location.search).get('puzzle') || './puzzle.ipuz';

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  puzzle: null,
  width: 0,
  height: 0,
  grid: [],        // [r][c] → { isBlack, number, acrossClueNumber, downClueNumber }
  clueMap: { across: {}, down: {} },
  entries: [],     // [r][c] → { letter, mode:'ink'|'pencil' } | null
  cellStatus: [],  // [r][c] → null | 'correct' | 'incorrect' | 'revealed'
  cursor: { row: 0, col: 0, direction: 'across' },
  activeWord: [],  // [{row,col}]
  timer: { seconds: 0, interval: null, running: false },
  pencilMode: false,
  isComplete: false,
};

// ── Bootstrap ────────────────────────────────────────────────────────────────
async function init() {
  let ipuz;
  try {
    const res = await fetch(PUZZLE_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    ipuz = await res.json();
  } catch (e) {
    document.getElementById('puzzle-title').textContent = 'Error loading puzzle';
    console.error(e);
    return;
  }

  state.puzzle = ipuz;
  state.width  = ipuz.dimensions.width;
  state.height = ipuz.dimensions.height;

  document.getElementById('puzzle-title').textContent = ipuz.title || 'Crossword';

  buildDerivedData();
  buildGrid();
  buildClueLists();

  // Set cursor to first white cell
  outer: for (let r = 0; r < state.height; r++) {
    for (let c = 0; c < state.width; c++) {
      if (!state.grid[r][c].isBlack) {
        state.cursor = { row: r, col: c, direction: 'across' };
        break outer;
      }
    }
  }
  computeActiveWord();
  renderHighlights();
  updateClueBar();
  updateClueListHighlight();

  startTimer();
  bindKeyboard();
  bindToolbar();
  bindDropdowns();
}

// ── Data layer ───────────────────────────────────────────────────────────────
function buildDerivedData() {
  const { width, height, puzzle: ipuz } = state;
  const raw = ipuz.puzzle;   // raw grid values
  const sol = ipuz.solution; // solution grid

  // Initialize 2-D arrays
  state.grid = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => ({
      isBlack: false, number: 0,
      acrossClueNumber: 0, downClueNumber: 0,
    }))
  );
  state.entries   = Array.from({ length: height }, () => Array(width).fill(null));
  state.cellStatus = Array.from({ length: height }, () => Array(width).fill(null));

  // 1. Parse raw values
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      let v = raw[r][c];
      if (typeof v === 'object' && v !== null) v = v.cell ?? v;
      if (v === '#' || v === null) {
        state.grid[r][c].isBlack = true;
      } else {
        const num = parseInt(v, 10);
        if (!isNaN(num) && num > 0) state.grid[r][c].number = num;
      }
    }
  }

  // 2. Assign across / down clue numbers
  let clueNum = 1;
  // We use the numbers already in the grid (from the ipuz) rather than reassigning
  // Re-derive numbers from grid layout to stay consistent
  // Reset and re-number:
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      state.grid[r][c].number = 0; // will reassign
    }
  }

  clueNum = 1;
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (state.grid[r][c].isBlack) continue;
      const startsAcross = (c === 0 || state.grid[r][c-1].isBlack) &&
                           (c + 1 < width && !state.grid[r][c+1].isBlack);
      const startsDown   = (r === 0 || state.grid[r-1][c].isBlack) &&
                           (r + 1 < height && !state.grid[r+1][c].isBlack);

      if (startsAcross || startsDown) {
        state.grid[r][c].number = clueNum++;
      }
      if (startsAcross) state.grid[r][c].acrossClueNumber = state.grid[r][c].number;
      if (startsDown)   state.grid[r][c].downClueNumber   = state.grid[r][c].number;
    }
  }

  // Propagate clue numbers along words
  for (let r = 0; r < height; r++) {
    let cur = 0;
    for (let c = 0; c < width; c++) {
      if (state.grid[r][c].isBlack) { cur = 0; continue; }
      if (state.grid[r][c].acrossClueNumber) cur = state.grid[r][c].acrossClueNumber;
      else state.grid[r][c].acrossClueNumber = cur;
    }
  }
  for (let c = 0; c < width; c++) {
    let cur = 0;
    for (let r = 0; r < height; r++) {
      if (state.grid[r][c].isBlack) { cur = 0; continue; }
      if (state.grid[r][c].downClueNumber) cur = state.grid[r][c].downClueNumber;
      else state.grid[r][c].downClueNumber = cur;
    }
  }

  // 3. Build clue maps from ipuz clue arrays
  const acrossRaw = ipuz.clues.Across || ipuz.clues.across || [];
  const downRaw   = ipuz.clues.Down   || ipuz.clues.down   || [];

  for (const [num, text] of acrossRaw) {
    state.clueMap.across[num] = { number: num, text, cells: [] };
  }
  for (const [num, text] of downRaw) {
    state.clueMap.down[num] = { number: num, text, cells: [] };
  }

  // Populate cells arrays
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const g = state.grid[r][c];
      if (g.isBlack) continue;
      const ac = g.acrossClueNumber;
      const dc = g.downClueNumber;
      if (ac && state.clueMap.across[ac]) state.clueMap.across[ac].cells.push({ row: r, col: c });
      if (dc && state.clueMap.down[dc])   state.clueMap.down[dc].cells.push({ row: r, col: c });
    }
  }
}

// ── Grid rendering ────────────────────────────────────────────────────────────
function buildGrid() {
  const gridEl = document.getElementById('grid');
  gridEl.innerHTML = '';
  gridEl.style.gridTemplateColumns = `repeat(${state.width}, var(--cell-size))`;

  for (let r = 0; r < state.height; r++) {
    for (let c = 0; c < state.width; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.r = r;
      cell.dataset.c = c;

      if (state.grid[r][c].isBlack) {
        cell.classList.add('cell-black');
      } else {
        const num = state.grid[r][c].number;
        if (num) {
          const numSpan = document.createElement('span');
          numSpan.className = 'cell-number';
          numSpan.textContent = num;
          cell.appendChild(numSpan);
        }
        const letterSpan = document.createElement('span');
        letterSpan.className = 'cell-letter';
        cell.appendChild(letterSpan);

        cell.addEventListener('click', () => handleCellClick(r, c));
      }

      gridEl.appendChild(cell);
    }
  }
}

function getCellEl(r, c) {
  return document.querySelector(`#grid .cell[data-r="${r}"][data-c="${c}"]`);
}

function renderCell(r, c) {
  const el = getCellEl(r, c);
  if (!el || state.grid[r][c].isBlack) return;

  const entry  = state.entries[r][c];
  const status = state.cellStatus[r][c];

  // Letter
  el.querySelector('.cell-letter').textContent = entry ? entry.letter : '';

  // Status classes
  el.classList.remove('cell-incorrect', 'cell-revealed', 'cell-pencil');
  if (status === 'incorrect') el.classList.add('cell-incorrect');
  else if (status === 'revealed') el.classList.add('cell-revealed');

  if (entry && entry.mode === 'pencil') el.classList.add('cell-pencil');
}

function renderHighlights() {
  // Strip old highlights
  document.querySelectorAll('.cell-selected, .cell-active-word').forEach(el => {
    el.classList.remove('cell-selected', 'cell-active-word');
  });

  // Paint active word
  for (const { row, col } of state.activeWord) {
    const el = getCellEl(row, col);
    if (el) el.classList.add('cell-active-word');
  }

  // Paint cursor on top
  const { row, col } = state.cursor;
  const curEl = getCellEl(row, col);
  if (curEl) {
    curEl.classList.remove('cell-active-word');
    curEl.classList.add('cell-selected');
  }
}

// ── Clue lists ────────────────────────────────────────────────────────────────
function buildClueLists() {
  const acrossList = document.getElementById('across-list');
  const downList   = document.getElementById('down-list');
  acrossList.innerHTML = '';
  downList.innerHTML   = '';

  const sortedAcross = Object.values(state.clueMap.across).sort((a, b) => a.number - b.number);
  const sortedDown   = Object.values(state.clueMap.down).sort((a, b) => a.number - b.number);

  for (const clue of sortedAcross) {
    acrossList.appendChild(makeClueItem(clue, 'across'));
  }
  for (const clue of sortedDown) {
    downList.appendChild(makeClueItem(clue, 'down'));
  }
}

function makeClueItem(clue, direction) {
  const li = document.createElement('li');
  li.className = 'clue-item';
  li.dataset.num = clue.number;
  li.dataset.dir = direction;

  const numSpan = document.createElement('span');
  numSpan.className = 'clue-num';
  numSpan.textContent = clue.number;

  const textSpan = document.createElement('span');
  textSpan.textContent = clue.text;

  li.appendChild(numSpan);
  li.appendChild(textSpan);

  li.addEventListener('click', () => {
    const firstCell = clue.cells[0];
    if (firstCell) moveCursor(firstCell.row, firstCell.col, direction);
  });

  return li;
}

function updateClueBar() {
  const { row, col, direction } = state.cursor;
  const g = state.grid[row][col];
  const num = direction === 'across' ? g.acrossClueNumber : g.downClueNumber;
  const clue = state.clueMap[direction][num];
  const dirLabel = direction === 'across' ? 'A' : 'D';

  document.getElementById('clue-bar-number').textContent = clue ? `${num}${dirLabel}` : '';
  document.getElementById('clue-bar-text').textContent   = clue ? clue.text : '';
}

function updateClueListHighlight() {
  document.querySelectorAll('.clue-item').forEach(el => el.classList.remove('clue-active'));

  const { row, col, direction } = state.cursor;
  const g = state.grid[row][col];
  const num = direction === 'across' ? g.acrossClueNumber : g.downClueNumber;

  const active = document.querySelector(`.clue-item[data-num="${num}"][data-dir="${direction}"]`);
  if (active) {
    active.classList.add('clue-active');
    active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

// ── Navigation ────────────────────────────────────────────────────────────────
function computeActiveWord() {
  const { row, col, direction } = state.cursor;
  state.activeWord = [];

  if (direction === 'across') {
    // Find start
    let c = col;
    while (c > 0 && !state.grid[row][c-1].isBlack) c--;
    while (c < state.width && !state.grid[row][c].isBlack) {
      state.activeWord.push({ row, col: c++ });
    }
  } else {
    let r = row;
    while (r > 0 && !state.grid[r-1][col].isBlack) r--;
    while (r < state.height && !state.grid[r][col].isBlack) {
      state.activeWord.push({ row: r++, col });
    }
  }
}

function wordLengthForCell(r, c, direction) {
  let len = 0;
  if (direction === 'across') {
    let cc = c;
    while (cc > 0 && !state.grid[r][cc-1].isBlack) cc--;
    while (cc < state.width && !state.grid[r][cc].isBlack) { len++; cc++; }
  } else {
    let rr = r;
    while (rr > 0 && !state.grid[rr-1][c].isBlack) rr--;
    while (rr < state.height && !state.grid[rr][c].isBlack) { len++; rr++; }
  }
  return len;
}

function moveCursor(row, col, direction) {
  if (state.grid[row][col].isBlack) return;
  state.cursor = { row, col, direction };
  computeActiveWord();
  renderHighlights();
  updateClueBar();
  updateClueListHighlight();
  focusMobileInput();
}

function handleCellClick(r, c) {
  const { row, col, direction } = state.cursor;
  if (r === row && c === col) {
    // Toggle direction if there's a valid word in the other direction
    const newDir = direction === 'across' ? 'down' : 'across';
    if (wordLengthForCell(r, c, newDir) > 1) {
      moveCursor(r, c, newDir);
    }
  } else {
    // Move to cell; keep direction if valid, else switch
    let newDir = direction;
    if (wordLengthForCell(r, c, direction) <= 1) {
      newDir = direction === 'across' ? 'down' : 'across';
    }
    moveCursor(r, c, newDir);
  }
}

function advanceCursor() {
  const { row, col, direction } = state.cursor;
  const word = state.activeWord;
  const idx = word.findIndex(p => p.row === row && p.col === col);
  // Advance to next empty cell, or last cell
  for (let i = idx + 1; i < word.length; i++) {
    const { row: nr, col: nc } = word[i];
    if (!state.entries[nr][nc]) {
      moveCursor(nr, nc, direction);
      return;
    }
  }
  // Just advance one if all filled
  if (idx + 1 < word.length) {
    const { row: nr, col: nc } = word[idx + 1];
    moveCursor(nr, nc, direction);
  }
}

function retreatCursor() {
  const { row, col, direction } = state.cursor;
  const word = state.activeWord;
  const idx = word.findIndex(p => p.row === row && p.col === col);
  if (idx > 0) {
    const { row: pr, col: pc } = word[idx - 1];
    moveCursor(pr, pc, direction);
  }
}

function handleArrowKey(key) {
  const { row, col, direction } = state.cursor;
  const keyDir = (key === 'ArrowLeft' || key === 'ArrowRight') ? 'across' : 'down';

  if (direction !== keyDir) {
    // First press: change direction only (if that direction has a valid word)
    if (wordLengthForCell(row, col, keyDir) > 1) {
      moveCursor(row, col, keyDir);
      return;
    }
  }

  // Move one step
  let nr = row, nc = col;
  if (key === 'ArrowLeft')  nc--;
  if (key === 'ArrowRight') nc++;
  if (key === 'ArrowUp')    nr--;
  if (key === 'ArrowDown')  nr++;

  if (nr >= 0 && nr < state.height && nc >= 0 && nc < state.width && !state.grid[nr][nc].isBlack) {
    moveCursor(nr, nc, keyDir);
  }
}

// Sorted clue list: all across by number, then all down by number
function orderedClues() {
  const across = Object.values(state.clueMap.across).sort((a, b) => a.number - b.number)
                       .map(c => ({ ...c, direction: 'across' }));
  const down   = Object.values(state.clueMap.down).sort((a, b) => a.number - b.number)
                       .map(c => ({ ...c, direction: 'down' }));
  return [...across, ...down];
}

function navigateToNextClue() {
  const { row, col, direction } = state.cursor;
  const g = state.grid[row][col];
  const curNum = direction === 'across' ? g.acrossClueNumber : g.downClueNumber;

  const clues = orderedClues();
  const idx = clues.findIndex(c => c.number === curNum && c.direction === direction);
  const next = clues[(idx + 1) % clues.length];
  if (next && next.cells.length) {
    moveCursor(next.cells[0].row, next.cells[0].col, next.direction);
  }
}

function navigateToPrevClue() {
  const { row, col, direction } = state.cursor;
  const g = state.grid[row][col];
  const curNum = direction === 'across' ? g.acrossClueNumber : g.downClueNumber;

  const clues = orderedClues();
  const idx = clues.findIndex(c => c.number === curNum && c.direction === direction);
  const prev = clues[(idx - 1 + clues.length) % clues.length];
  if (prev && prev.cells.length) {
    moveCursor(prev.cells[0].row, prev.cells[0].col, prev.direction);
  }
}

// ── Keyboard ──────────────────────────────────────────────────────────────────
function bindKeyboard() {
  document.addEventListener('keydown', handleKeydown);

  const mobileInput = document.getElementById('mobile-input');
  mobileInput.addEventListener('input', e => {
    const ch = (e.data || '').replace(/[^a-zA-Z]/g, '').slice(-1).toUpperCase();
    if (ch) writeLetter(ch);
    mobileInput.value = '';
  });
}

function handleKeydown(e) {
  // Don't intercept when typing in toolbar inputs
  if (e.target !== document.body && e.target.tagName !== 'DIV' &&
      e.target.id !== 'mobile-input') return;

  const { row, col, direction } = state.cursor;

  if (e.key.length === 1 && /[a-zA-Z]/.test(e.key)) {
    e.preventDefault();
    writeLetter(e.key.toUpperCase());
    return;
  }

  switch (e.key) {
    case 'Backspace':
      e.preventDefault();
      if (state.entries[row][col]) {
        state.entries[row][col] = null;
        state.cellStatus[row][col] = null;
        renderCell(row, col);
      } else {
        retreatCursor();
        const { row: pr, col: pc } = state.cursor;
        state.entries[pr][pc] = null;
        state.cellStatus[pr][pc] = null;
        renderCell(pr, pc);
      }
      break;
    case 'Delete':
      e.preventDefault();
      state.entries[row][col] = null;
      state.cellStatus[row][col] = null;
      renderCell(row, col);
      break;
    case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown':
      e.preventDefault();
      handleArrowKey(e.key);
      break;
    case 'Tab':
      e.preventDefault();
      e.shiftKey ? navigateToPrevClue() : navigateToNextClue();
      break;
    case 'Enter':
      e.preventDefault();
      navigateToNextClue();
      break;
  }
}

function writeLetter(letter) {
  if (state.isComplete) return;
  const { row, col, direction } = state.cursor;
  state.entries[row][col] = { letter, mode: state.pencilMode ? 'pencil' : 'ink' };
  // Clear incorrect status when overwriting
  if (state.cellStatus[row][col] === 'incorrect') state.cellStatus[row][col] = null;
  renderCell(row, col);
  advanceCursor();
  checkCompletion();
}

// ── Mobile input ──────────────────────────────────────────────────────────────
function focusMobileInput() {
  if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
    document.getElementById('mobile-input').focus();
  }
}

// ── Timer ─────────────────────────────────────────────────────────────────────
function startTimer() {
  if (state.timer.running) return;
  state.timer.running = true;
  state.timer.interval = setInterval(() => {
    if (!state.isComplete) {
      state.timer.seconds++;
      renderTimer();
    }
  }, 1000);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearInterval(state.timer.interval);
      state.timer.running = false;
    } else if (!state.isComplete) {
      startTimer();
    }
  });
}

function renderTimer() {
  const s = state.timer.seconds;
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  document.getElementById('timer-display').textContent = `${m}:${ss}`;
}

function stopTimer() {
  clearInterval(state.timer.interval);
  state.timer.running = false;
}

// ── Check / Reveal ────────────────────────────────────────────────────────────
function solutionAt(r, c) {
  const v = state.puzzle.solution[r][c];
  if (!v) return null;
  return String(v).toUpperCase();
}

function checkCells(cells) {
  for (const { row, col } of cells) {
    if (state.grid[row][col].isBlack) continue;
    if (state.cellStatus[row][col] === 'revealed') continue;
    const entry = state.entries[row][col];
    if (!entry) continue;
    const correct = solutionAt(row, col);
    state.cellStatus[row][col] = (entry.letter === correct) ? 'correct' : 'incorrect';
    renderCell(row, col);
  }
}

function revealCells(cells) {
  for (const { row, col } of cells) {
    if (state.grid[row][col].isBlack) continue;
    const sol = solutionAt(row, col);
    if (!sol) continue;
    state.entries[row][col] = { letter: sol, mode: 'ink' };
    state.cellStatus[row][col] = 'revealed';
    renderCell(row, col);
  }
  checkCompletion();
}

function allNonBlackCells() {
  const cells = [];
  for (let r = 0; r < state.height; r++)
    for (let c = 0; c < state.width; c++)
      if (!state.grid[r][c].isBlack) cells.push({ row: r, col: c });
  return cells;
}

function dispatchAction(action) {
  const { row, col } = state.cursor;
  if (action === 'check-letter') {
    checkCells([{ row, col }]);
  } else if (action === 'check-word') {
    checkCells(state.activeWord);
  } else if (action === 'check-puzzle') {
    checkCells(allNonBlackCells());
  } else if (action === 'reveal-letter') {
    revealCells([{ row, col }]);
  } else if (action === 'reveal-word') {
    revealCells(state.activeWord);
  } else if (action === 'reveal-puzzle') {
    revealCells(allNonBlackCells());
  }
}

// ── Completion ────────────────────────────────────────────────────────────────
function checkCompletion() {
  if (state.isComplete) return;
  for (let r = 0; r < state.height; r++) {
    for (let c = 0; c < state.width; c++) {
      if (state.grid[r][c].isBlack) continue;
      const entry = state.entries[r][c];
      if (!entry) return;
      const sol = solutionAt(r, c);
      if (!sol) return;
      if (entry.letter !== sol) return;
    }
  }
  // All correct!
  state.isComplete = true;
  stopTimer();
  launchBirthday();
}

function showCompletionModal() {
  const s = state.timer.seconds;
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  document.getElementById('modal-time').textContent = `Solved in ${m}:${ss}`;
  document.getElementById('modal-overlay').classList.remove('hidden');
}

// ── Toolbar / dropdowns ───────────────────────────────────────────────────────
function bindToolbar() {
  document.getElementById('btn-pencil').addEventListener('click', () => {
    state.pencilMode = !state.pencilMode;
    document.getElementById('btn-pencil').classList.toggle('pencil-mode-active', state.pencilMode);
  });

  document.getElementById('modal-close').addEventListener('click', () => {
    document.getElementById('modal-overlay').classList.add('hidden');
  });
}

function bindDropdowns() {
  const toggles = document.querySelectorAll('.dropdown-toggle');
  toggles.forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      // Close other menus
      document.querySelectorAll('.dropdown-menu.open').forEach(m => {
        if (m !== btn.nextElementSibling) m.classList.remove('open');
      });
      btn.nextElementSibling.classList.toggle('open');
    });
  });

  document.querySelectorAll('.dropdown-menu button').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      dispatchAction(btn.dataset.action);
      document.querySelectorAll('.dropdown-menu.open').forEach(m => m.classList.remove('open'));
    });
  });

  document.addEventListener('click', () => {
    document.querySelectorAll('.dropdown-menu.open').forEach(m => m.classList.remove('open'));
  });
}

// ── Birthday celebration ──────────────────────────────────────────────────────
function birthdayActive() {
  return !!document.getElementById('birthday-overlay');
}

function clearBirthday() {
  const el = document.getElementById('birthday-overlay');
  if (el) el.remove();
  stopBirthdayMusic();
}

function launchBirthday() {
  if (birthdayActive()) return;

  const s = state.timer.seconds;
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  const timeStr = `Solved in ${m}:${ss}`;

  const overlay = document.createElement('div');
  overlay.id = 'birthday-overlay';
  overlay.innerHTML = `
    <div class="bday-scene">
      <div class="confetti-wrap" id="confetti-wrap"></div>
      <div class="bday-msg">🎂 Happy 40th Birthday, Christine! 🎂</div>
      <div class="bday-sub">Love, Peter</div>
      <img class="bday-cake-gif" src="FKCake.gif" alt="FKK with birthday cake">
      <div class="bday-time">${timeStr}</div>
      <div class="bday-hint">Click anywhere to dismiss</div>
    </div>`;
  document.body.appendChild(overlay);

  // Spawn confetti
  const wrap = document.getElementById('confetti-wrap');
  for (let i = 0; i < 60; i++) {
    const c = document.createElement('div');
    c.className = 'confetto';
    c.style.cssText = `left:${Math.random()*100}%;animation-delay:${Math.random()*3}s;
      animation-duration:${2+Math.random()*3}s;background:hsl(${Math.random()*360},90%,60%);
      width:${6+Math.random()*8}px;height:${6+Math.random()*8}px;
      border-radius:${Math.random()>.5?'50%':'2px'};`;
    wrap.appendChild(c);
  }

  overlay.addEventListener('click', clearBirthday);
  playBirthdayMusic();
}

// ── Happy Birthday via Web Audio ──────────────────────────────────────────────
let bdayAudioCtx = null;
const bdayTimeouts = [];

function stopBirthdayMusic() {
  bdayTimeouts.forEach(clearTimeout);
  bdayTimeouts.length = 0;
  if (bdayAudioCtx) { try { bdayAudioCtx.close(); } catch(e){} bdayAudioCtx = null; }
}

function playBirthdayMusic() {
  stopBirthdayMusic();
  bdayAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const ctx = bdayAudioCtx;

  // note frequencies
  const N = { C4:261.63,D4:293.66,E4:329.63,F4:349.23,G4:392.00,
               A4:440.00,Bb4:466.16,C5:523.25,F5:698.46 };

  // Happy Birthday: [freq, beats]  (beat = 0.35s at this tempo)
  const song = [
    [N.C4,0.75],[N.C4,0.25],[N.D4,1],[N.C4,1],[N.F4,1],[N.E4,2],
    [N.C4,0.75],[N.C4,0.25],[N.D4,1],[N.C4,1],[N.G4,1],[N.F4,2],
    [N.C4,0.75],[N.C4,0.25],[N.C5,1],[N.A4,1],[N.F4,1],[N.E4,1],[N.D4,2],
    [N.Bb4,0.75],[N.Bb4,0.25],[N.A4,1],[N.F4,1],[N.G4,1],[N.F4,2],
  ];

  const beat = 0.35;
  let t = ctx.currentTime + 0.1;

  for (const [freq, beats] of song) {
    const dur = beats * beat;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.4, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur * 0.9);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur);
    t += dur;
  }
}

// ── Run ───────────────────────────────────────────────────────────────────────
init();
