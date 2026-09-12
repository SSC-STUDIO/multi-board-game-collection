/**
 * Single source of truth for where every diegetic prop lives on the tabletop.
 *
 * World axes: Y is up, +Z points toward the viewer (the MAIN_PLAY camera sits at
 * +Z looking back at the origin), +X is to the viewer's right.
 * The table's top surface is the plane y = 0; every prop rests on it.
 *
 * Board rows: row 0 is the far edge (−Z), row 14 is the near edge (+Z).
 * Board cols: col 0 is the left edge (−X), col 14 is the right edge (+X).
 *
 * This file is pure JS (no Three.js) so `tests/` can import it.
 */

export const BOARD_CELLS = 15;
export const CELL_SIZE = 0.7;
export const GRID_SPAN = (BOARD_CELLS - 1) * CELL_SIZE; // 9.8
export const BOARD_FRAME = 0.4;
export const BOARD_THICKNESS = 0.6;
export const BOARD_TOP_Y = BOARD_THICKNESS;
export const BOARD_FULL_SIZE = GRID_SPAN + BOARD_FRAME * 2; // 10.6

export const STONE_RADIUS = 0.31;
export const STONE_HEIGHT = 0.17;

export const LAYOUT = Object.freeze({
  TABLE: Object.freeze({ size: [34, 24], thickness: 1.0, legHeight: 7.0, topY: 0 }),
  FLOOR_Y: -8.0,

  BOARD: Object.freeze({
    position: [0, 0, 0],
    cells: BOARD_CELLS,
    cellSize: CELL_SIZE,
    thickness: BOARD_THICKNESS,
    frame: BOARD_FRAME,
  }),

  // Right-back: dual mechanical chess clock. Camera CLOCK_FOCUS targets [8.5, 2.0, 1.0].
  CLOCK: Object.freeze({ position: [8.6, 0, 0.8], size: [3.0, 1.7, 1.3], tiltDeg: 15 }),

  // Left-front: brass rewinding sandglass (undo).
  SANDGLASS: Object.freeze({ position: [-7.4, 0, 4.6], height: 2.4, radius: 0.6 }),

  // Left-back: stitched xuan-paper strategy manual. Camera MANUAL_STUDY targets [-6.5, 0.5, -2.0].
  MANUAL: Object.freeze({ position: [-7.4, 0, -2.4], size: [3.2, 0.3, 4.5] }),

  // Right-front: leather score ledger. Camera LEDGER_REVIEW targets [6.0, 0.5, 4.5].
  LEDGER: Object.freeze({ position: [6.7, 0, 5.0], size: [2.4, 0.25, 3.2] }),

  // Go bowls: black walnut on the left, white ash on the right.
  BOWL_BLACK: Object.freeze({ position: [-8.2, 0, 1.6], radius: 1.0, height: 0.9 }),
  BOWL_WHITE: Object.freeze({ position: [9.0, 0, 3.6], radius: 1.0, height: 0.9 }),

  // Front-left: keep the tall stamp outside the sightline to the desk controls.
  STAMP: Object.freeze({ position: [-5.9, 0, 7.4], size: 0.9, height: 1.6 }),
  INK_BOX: Object.freeze({ position: [-4.5, 0, 8.0], radius: 0.55, height: 0.35 }),

  // The two players. Scale: one unit ≈ 4 cm (the 15×15 grid spans 9.8 units ≈ 40 cm), so a seated
  // adult has hips on the stool seat (y −2.3), shoulders ≈ 12 units higher (world y ≈ 9.7), the head
  // centre ≈ 3.2 above that and an arm reach of ≈ 18. The far figure is the AI opponent facing +Z; the
  // near figure is the player, facing −Z, whose head hosts the MAIN_PLAY camera (0, 13, 16.2).
  SEAT_FAR: Object.freeze({ position: [0, -2.3, -16.5], facing: 1, shoulderY: 12.0, shoulderHalfWidth: 4.3, armReach: 18 }),
  SEAT_NEAR: Object.freeze({ position: [0, -2.3, 16.5], facing: -1, shoulderY: 12.0, shoulderHalfWidth: 4.3, armReach: 18 }),

  // Small lacquer dish at the opponent's right hand (their right is −X) holding the AI's stones.
  TRAY: Object.freeze({ position: [-6.2, 0, -9.0], radius: 0.95, height: 0.45 }),
});

/** Interactive object ids shared between entities, InteractionManager and main.js. */
export const INTERACTIVE = Object.freeze({
  BOARD: 'board',
  TABLE: 'table',
  CLOCK_PLUNGER: 'clock_plunger',
  CLOCK_BODY: 'clock_body',
  SANDGLASS: 'sandglass',
  MANUAL: 'manual',
  LEDGER_PAGE: 'ledger_page',
  LEDGER_NEXT: 'ledger_next',
  LEDGER_PREV: 'ledger_prev',
  BOWL_BLACK: 'bowl_black',
  BOWL_WHITE: 'bowl_white',
  STAMP: 'stamp',
});

/**
 * Board intersection → world coordinates (on the board's top surface by default).
 * @returns {{x:number, y:number, z:number}}
 */
export function boardToWorld(row, col, y = BOARD_TOP_Y) {
  return {
    x: -GRID_SPAN / 2 + col * CELL_SIZE,
    y,
    z: -GRID_SPAN / 2 + row * CELL_SIZE,
  };
}

/**
 * World XZ → nearest board intersection, or null when the point lies outside
 * the grid (plus half a cell of slack so edge lines are clickable).
 * @returns {{row:number, col:number} | null}
 */
export function worldToBoard(x, z) {
  const col = Math.round((x + GRID_SPAN / 2) / CELL_SIZE);
  const row = Math.round((z + GRID_SPAN / 2) / CELL_SIZE);
  if (row < 0 || row >= BOARD_CELLS || col < 0 || col >= BOARD_CELLS) return null;
  const p = boardToWorld(row, col);
  const half = CELL_SIZE / 2 + 1e-6;
  if (Math.abs(p.x - x) > half || Math.abs(p.z - z) > half) return null;
  return { row, col };
}

/** Centre of a set of cells (e.g. the winning line) in world space. */
export function cellsCenterWorld(cells, y = BOARD_TOP_Y) {
  if (!cells || cells.length === 0) return { x: 0, y, z: 0 };
  let sx = 0;
  let sz = 0;
  for (const c of cells) {
    const p = boardToWorld(c.row, c.col, y);
    sx += p.x;
    sz += p.z;
  }
  return { x: sx / cells.length, y, z: sz / cells.length };
}
