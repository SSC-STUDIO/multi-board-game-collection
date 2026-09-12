/**
 * Zenith-Tabletop-3D bootstrap.
 *
 * Wires the DOM-free game core to the diegetic 3D props. The flow is strictly
 * one-directional: pointer → InteractionManager → GameEngine action → engine
 * event → entity animation / camera move. Entities never mutate game state.
 *
 * Session flow: start screen (cinematic TITLE sweep behind it) → "入座对弈"
 * flies the camera to MAIN_PLAY and removes the overlay from the DOM → bowls
 * pick the colour → play. Esc pauses and brings the settings sheet back.
 * First visit: a guided tour of the props runs once after sitting down.
 * "复原棋局" restores a position from a photo / record and returns to colour selection.
 *
 * The only 2D text over the play viewport is the bottom caption strip (ui/Hud.js):
 * end-of-game "how to play again" hints, the tutorial steps and the restored-position note.
 *
 * URL overrides (see ui/Settings.js): ?mode=renju ?time=300 ?depth=4 ?quality=low
 * Diagnostics: ?debug=1 shows fps / frame time / draw calls / resolution / GPU in the corner.
 * Optional LLM coach / vision: window.ZENITH_CONFIG = { llm: { endpoint, apiKey, model, visionModel } } before this script.
 * Keys during play: Esc menu · Z undo · H coach · Space pause.
 */
import { Vector3 } from 'three';
import { GameEngine, GameEvent, GameStatus, FinishReason, BLACK, WHITE, opponentOf, toRecord } from './core/index.js';
import { World } from './spatial/World.js';
import { Lighting } from './spatial/Lighting.js';
import { CameraDirector, USER_ORBIT_LIMITS } from './spatial/camera/CameraDirector.js';
import { CameraShake } from './spatial/camera/CameraShake.js';
import { OrbitInput } from './spatial/camera/OrbitInput.js';
import { InteractionManager } from './spatial/picker/InteractionManager.js';
import { Spotlight } from './spatial/picker/Spotlight.js';
import { INTERACTIVE, BOARD_TOP_Y, LAYOUT, cellsCenterWorld } from './spatial/Layout.js';
import { Tabletop } from './spatial/entities/Tabletop.js';
import { TableConsole } from './spatial/entities/TableConsole.js';
import { Board } from './spatial/entities/Board.js';
import { Bowls } from './spatial/entities/Bowls.js';
import { ChessClock } from './spatial/entities/ChessClock.js';
import { Sandglass } from './spatial/entities/Sandglass.js';
import { Manual } from './spatial/entities/Manual.js';
import { ScoreLedger } from './spatial/entities/ScoreLedger.js';
import { VictoryStamp } from './spatial/entities/VictoryStamp.js';
import { Room, ROOM } from './spatial/entities/Room.js';
import { TableDecor } from './spatial/entities/TableDecor.js';
import { StoneTray } from './spatial/entities/StoneTray.js';
import { Figure } from './spatial/entities/Figure.js';
import { Audio3D } from './services/Audio3D.js';
import { AiService } from './services/AiService.js';
import { SessionStore } from './services/SessionStore.js';
import { AssetLibrary } from './services/AssetLibrary.js';
import { LLMCoachService } from './services/LLMCoachService.js';
import { StartScreen } from './ui/StartScreen.js';
import { Hud } from './ui/Hud.js';
import { Tutorial } from './ui/Tutorial.js';
import { PositionImporter } from './ui/PositionImporter.js';
import { DebugStats } from './ui/DebugStats.js';
import { QUALITY_PROFILES, loadSettings, saveSettings, resolveQuality, loadStats, saveStats } from './ui/Settings.js';
import { sleep } from './utils/Tween.js';

const SEAL_TEXT = Object.freeze({ WIN: '大捷', LOSS: '承让', DRAW: '和局' });
const SIDE_NAME = Object.freeze({ [BLACK]: '黑', [WHITE]: '白' });
const FORBIDDEN_NAME = Object.freeze({ DOUBLE_THREE: '三三', DOUBLE_FOUR: '四四', OVERLINE: '长连' });
const AI_THINK_DELAY_MS = 650;
const AI_TIME_LIMIT_MS = 800;
const INTRO_FLIGHT_MS = 1400;
const TUTORIAL_FLIGHT_MS = 800;
const now = () => Date.now();

/** @typedef {import('./ui/Settings.js').DEFAULT_SETTINGS} Settings */

export class ZenithApp {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {Settings} settings
   */
  constructor(canvas, settings, { debug = false, assets = null } = {}) {
    this.settings = settings;
    this.llm = globalThis.ZENITH_CONFIG?.llm ?? null;
    /** @type {AssetLibrary | null} downloaded CC0 textures / models / HDRI (optional) */
    this.assets = assets;
    const profile = QUALITY_PROFILES[resolveQuality(settings.quality)];

    this.engine = new GameEngine({ mode: settings.mode, initialMs: settings.timeMinutes * 60_000 });

    this.world = new World(canvas, {
      antialias: profile.antialias,
      shadows: profile.shadows,
      shadowType: profile.shadowType,
      maxPixelRatio: profile.maxPixelRatio,
      maxPixels: profile.maxPixels,
    });
    this.world.setPostFX(profile.postfx);
    this.lighting = new Lighting(this.world.scene, this.world.renderer, { ibl: profile.ibl, shadowMapSize: profile.shadowMapSize });
    this.director = new CameraDirector(this.world.camera, {
      orbitLimits: {
        ...USER_ORBIT_LIMITS,
        // Free-look may never leave the room: walls, floor (with headroom) and the beamed ceiling.
        bounds: {
          min: [-ROOM.halfWidth, LAYOUT.FLOOR_Y + 2.5, ROOM.backZ],
          max: [ROOM.halfWidth, ROOM.ceilingY - 1.6, ROOM.frontZ],
          margin: 1.0,
        },
      },
    });
    this.shake = new CameraShake();
    this.audio = new Audio3D(this.world.camera);
    this.audio.setMuted(!settings.sound);
    this.interactions = new InteractionManager(this.world.camera, canvas);
    this.orbitInput = new OrbitInput(canvas, this.director, { enabled: false });
    this.ai = new AiService();
    this.coach = new LLMCoachService({
      analyze: (state) => this.ai.analyze(state, { depth: this.settings.aiDepth, timeLimitMs: AI_TIME_LIMIT_MS }),
      endpoint: this.llm?.endpoint ?? null,
      apiKey: this.llm?.apiKey ?? null,
      model: this.llm?.model ?? 'gpt-4o-mini',
    });
    this.debugStats = debug ? new DebugStats(this.world) : null;
    console.info(`[zenith] GPU: ${this.world.gpuName} · quality ${resolveQuality(settings.quality)} · AI ${this.ai.offThread ? 'worker' : 'main thread'}`);

    const audio = this.audio;
    this.tabletop = new Tabletop({ audio });
    this.tableConsole = new TableConsole();
    this.board = new Board({ audio });
    this.bowls = new Bowls({ audio });
    this.clock = new ChessClock({ audio });
    this.sandglass = new Sandglass({ audio });
    this.sandglass.setTransmission(profile.transmission);
    this.manual = new Manual({ audio });
    this.ledger = new ScoreLedger({ audio });
    this.stamp = new VictoryStamp({ audio });
    this.room = new Room({ audio });
    this.room.setLanternLights(profile.lanternLights);
    this.room.setShellShading(profile.roomShading);
    // Scanned glTF props replace their procedural stand-ins when the download exists.
    this.decor = new TableDecor({ audio });
    // The two players: the opponent across the table and the player's own body, whose eyes are the MAIN_PLAY camera.
    this.tray = new StoneTray({ audio });
    this.opponent = new Figure({ audio, seat: LAYOUT.SEAT_FAR, name: 'opponent', palette: { robe: 0x3c4a6b, sash: 0x8a2b2b } });
    this.player = new Figure({ audio, seat: LAYOUT.SEAT_NEAR, name: 'player', palette: { robe: 0x5a4a3a, sash: 0x2f3e2a } });
    this.entities = [
      this.room, this.tabletop, this.tableConsole, this.decor, this.board, this.bowls, this.clock,
      this.sandglass, this.manual, this.ledger, this.stamp, this.tray, this.opponent, this.player,
    ];
    for (const entity of this.entities) this.world.add(entity);
    this.applyDownloadedAssets().catch((err) => console.warn('[zenith] asset upgrade failed:', err));

    /** @type {ReturnType<typeof setTimeout> | null} */
    this.aiTimer = null;
    /** Bumped by cancelAi(); an in-flight worker result with a stale token is dropped. */
    this.aiRequest = 0;
    this.undoBusy = false;
    this.ceremonyBusy = false;
    this.hintRequest = 0;
    this.seated = false;
    this.menuOpen = false;
    this.review = null;
    this.pausedByMenu = false;
    /** Per-side thinking time for untimed games (the core only tracks countdowns). */
    this.elapsedMs = { [BLACK]: 0, [WHITE]: 0 };
    /**
     * Stones the engine has committed but a hand is still carrying: key "row,col" →
     * resolver of the landing promise. Undo / reset clear entries so a cancelled
     * gesture can never drop its stone late.
     * @type {Map<string, { move: object, promise: Promise<void>, land: () => void }>}
     */
    this.carrying = new Map();
    /** Which carry (key) each hand is busy with, so bursts of moves never lose a stone. */
    this.playerArms = { left: null, right: null };
    this.opponentArms = { left: null, right: null };
    this.opponentThinking = false;
    this._penGrip = new Vector3();
    this._penDir = new Vector3();
    this._camPos = new Vector3();
    this._headPos = new Vector3();
    this._penHeld = false;

    this.hud = new Hud({ onAction: (id) => this.onHudAction(id) });
    this.spotlight = new Spotlight();
    /** Prop groups the tutorial may glow, by step name. Stones are excluded: only the board slab lights up. */
    this.spotTargets = {
      bowls: this.bowls.group, board: this.board.surface, clock: this.clock.group, sandglass: this.sandglass.group,
      manual: this.manual.group, ledger: this.ledger.group, stamp: this.stamp.group, opponent: this.opponent.group,
    };
    this.tutorial = new Tutorial({
      hud: this.hud,
      onStep: (step) => this.onTutorialStep(step),
      onFinish: () => this.onTutorialFinished(),
    });
    /** First visit: the tour starts by itself once the player has sat down. */
    this.pendingTutorial = !Tutorial.isDone();
    /** Whether the game was paused by the menu when the tour began (resume afterwards). */
    this.tutorialResume = false;
    this.stats = loadStats();
    this.sessions = new SessionStore();
    this.savedSession = this.sessions.load();
    this.lastSessionSave = 0;
    this.gameEpoch = 0;

    this.importer = new PositionImporter({
      vision: this.llm?.endpoint ? { endpoint: this.llm.endpoint, apiKey: this.llm.apiKey ?? null, model: this.llm.visionModel ?? this.llm.model ?? 'gpt-4o-mini' } : null,
      onConfirm: (position) => this.enterTableWithPosition(position).catch(console.error),
      onCancel: () => this.startScreen.back(),
    });
    this.startScreen = new StartScreen({
      settings,
      importer: this.importer,
      stats: this.stats,
      savedGame: this.savedSession?.game,
      onContinueSaved: () => this.resumeSavedGame().catch(console.error),
      onStart: (s) => this.enterTable(s).catch(console.error),
      onResume: (s) => this.closeMenu(s),
      onNewGame: (s) => this.newGameFromMenu(s),
      onChange: (s) => this.applyLiveSettings(s),
      onTutorial: (s) => this.startTutorial(s),
      onSave: () => this.saveRecord(),
      onResign: (s) => this.resignFromMenu(s),
    });

    this.unsubscribers = [
      this.engine.on(GameEvent.GAME_RESET, () => this.onGameReset()),
      this.engine.on(GameEvent.POSITION_LOADED, (p, _e, s) => this.onPositionLoaded(p, s)),
      this.engine.on(GameEvent.COLOR_SELECTED, (p, _e, s) => this.onColorSelected(p, s)),
      this.engine.on(GameEvent.MOVE_COMMITTED, (p, _e, s) => this.onMoveCommitted(p, s)),
      this.engine.on(GameEvent.TURN_SWITCHED, (p) => this.onTurnSwitched(p)),
      this.engine.on(GameEvent.STATE_REVERTED, (p, _e, s) => this.onStateReverted(p, s).catch(console.error)),
      this.engine.on(GameEvent.PAUSE_TOGGLED, (p) => this.onPauseToggled(p)),
      this.engine.on(GameEvent.GAME_FINISHED, (p, _e, s) => this.onGameFinished(p, s).catch(console.error)),
      this.engine.on(GameEvent.INVALID_ACTION, (p) => console.debug('[zenith] rejected action:', p.error)),
      this.engine.on(GameEvent.STATE_CHANGED, (p) => this.persistSession(p.action.type !== 'TICK')),
      this.world.onBeforeRender((dt) => this.syncClock(dt)),
      this.world.onAfterUpdate((dt, elapsed) => this.updateCameraAndServices(dt, elapsed)),
    ];

    this.bindInteractions();
    this.bindAudioUnlock(canvas);
    this._onKeyDown = (e) => this.onKeyDown(e);
    window.addEventListener('keydown', this._onKeyDown);
    this._onPageHide = () => this.persistSession(true);
    this._onVisibilityChange = () => {
      if (!document.hidden || !this.seated) return;
      if (this.engine.status === GameStatus.PLAYING && !this.tutorial.active) this.openMenu();
      this.persistSession(true);
    };
    window.addEventListener('pagehide', this._onPageHide);
    document.addEventListener('visibilitychange', this._onVisibilityChange);

    // Title state: slow cinematic sweep behind the settings sheet, table locked.
    this.director.snapTo('TITLE');
    this.interactions.setEnabled(false);
    this.enterSelection();
    this.startScreen.show('title');
    this.world.start();
  }

  /** Undo flight or victory ceremony in progress: board input is locked. */
  get busy() {
    return this.undoBusy || this.ceremonyBusy;
  }

  // ---------------------------------------------------------------------------
  // downloaded assets (all optional: procedural materials stay when absent)
  // ---------------------------------------------------------------------------

  /**
   * Swap scanned PBR texture sets onto the big surfaces, drop in the glTF props
   * and replace the built-in environment with a photographed HDRI. Everything
   * streams in asynchronously; the procedural look remains until each arrives.
   */
  async applyDownloadedAssets() {
    const assets = this.assets;
    if (!assets?.available) return;
    assets.anisotropy = Math.min(16, this.world.renderer.capabilities.getMaxAnisotropy());
    const { scene } = this.world;
    const floorY = LAYOUT.FLOOR_Y;

    // Table: walnut veneer tiled finely enough for the grain to read from the play camera.
    assets.applyPbr(this.tabletop.topMaterial, 'table_walnut', { repeat: [3, 2.1], color: 0x6a5646, normalScale: 1.5 });
    assets.applyPbr([this.tabletop.apronMaterial, this.tabletop.legMaterial], 'table_walnut', { repeat: [1.5, 0.5], color: 0x8a7460 });

    // Board: straight-grained oak veneer warmed toward kaya honey; the grid is repainted over the photo
    // and the normal / roughness maps come from the same set so the relief lines up.
    const kayaTint = 0xf4d6a2;
    assets.loadImage('board_oak').then((img) => {
      if (!img) return;
      this.board.setWoodImage(img);
      this.board.topMaterial.color.set(kayaTint);
    });
    assets.applyPbr(this.board.topMaterial, 'board_oak', { maps: ['nor_gl', 'arm'], normalScale: 0.5, roughness: 0.85 });
    assets.applyPbr(this.board.sideMaterial, 'board_oak', { repeat: [0.25, 1], rotation: Math.PI / 2, color: kayaTint });

    // Room shell (both the PBR and the Lambert twin of each surface). The walls keep the procedural
    // plaster: the scanned sheet showed faint tile seams across 60-unit walls and adds little at range.
    assets.applyPbr(this.room.shellMaterials('plankFloor'), 'floor_planks', { repeat: [8, 7], color: 0xb8a898 });
    assets.applyPbr(this.room.shellMaterials('floorMat'), 'hessian', { repeat: [5, 4], color: 0x8f7a5e });
    assets.applyPbr(this.room.shellMaterials('wainscot'), 'table_walnut', { color: 0x7a6250 });

    // Props.
    assets.applyPbr(this.clock.woodMaterial, 'rosewood', { normalScale: 0.6 });
    assets.applyPbr(this.ledger.leatherMaterial, 'leather', { repeat: [1.5, 1.5], color: 0x6a4a34 });
    if (this.decor.cushionMaterials) assets.applyPbr(this.decor.cushionMaterials, 'velvet', { repeat: [2, 2] });

    // Photographed environment for reflections (warm wooden attic with soft daylight). Kept below the
    // built-in room's level so the directional key/spot still carve the shapes.
    assets.loadHdri('pine_attic').then((tex) => {
      if (tex) this.lighting.setEnvironmentTexture(tex, { intensityScale: 0.55 });
    });

    const place = async (promise, [x, y, z], yaw = 0) => {
      const group = await promise;
      if (!group) return null;
      group.position.set(x, y, z);
      group.rotation.y = yaw;
      scene.add(group);
      this.world.invalidateShadows();
      return group;
    };
    const hideFallback = (name, model) => {
      if (model) this.decor.group.traverse(o => { if (o.name === name) o.visible = false; });
    };
    for (const [id, figure] of [['kaykit_mage', this.opponent], ['kaykit_rogue', this.player]]) {
      assets.loadModel(id).then(model => figure.setCharacterModel(model))
        .catch(err => console.warn(`[zenith] character rig failed: ${id}`, err.message));
    }
    // Seat tops land at y = −2.3 like the procedural stools, so seated figures stay in place.
    Promise.all([
      place(assets.loadModel('chinese_stool', { height: 5.7 }), [0, floorY, 16.5], 0),
      place(assets.loadModel('chinese_stool', { height: 5.7 }), [0, floorY, -16.5], Math.PI),
    ]).then(models => { if (models.every(Boolean)) hideFallback('stool', models[0]); });
    place(assets.loadModel('chinese_armchair', { height: 13 }), [16.5, floorY, -17.8], -0.35);
    place(assets.loadModel('book_encyclopedia_set_01', {
      width: 3.8, roll: -Math.PI / 2,
      nodes: ['book_encyclopedia_set_01_book01', 'book_encyclopedia_set_01_book02', 'book_encyclopedia_set_01_book03'],
    }), [-12.6, 0, 3.4], -0.1)
      .then(model => hideFallback('books', model));
    place(assets.loadModel('antique_ceramic_vase_01', { height: 7 }), [-25, floorY, -19], 0.3);
    place(assets.loadModel('potted_plant_01', { height: 8.5 }), [25.5, floorY, 9], 0.6)
      .then(model => hideFallback('bonsai', model));
    // Side tea table with the porcelain set resting on its top.
    place(assets.loadModel('chinese_tea_table', { height: 6.5 }), [23.5, floorY, 1.5], Math.PI / 2).then(async (table) => {
      if (!table) return;
      const tea = await place(assets.loadModel('tea_set_01', { width: 3.4 }), [23.5, floorY + table.userData.size.y, 1.5], -0.4);
      hideFallback('teaSet', tea);
    });
  }

  // ---------------------------------------------------------------------------
  // session / settings
  // ---------------------------------------------------------------------------

  /** "入座对弈": apply settings, fly from the title sweep to the play view, unlock the table. */
  async enterTable(settings) {
    this.applyLiveSettings(settings);
    this.engine.reset({ mode: settings.mode, initialMs: settings.timeMinutes * 60_000 });
    this.startScreen.hide();
    this.hud.setSuppressed(false);
    this.lighting.setMood('play');
    await this.director.goTo('MAIN_PLAY', { duration: INTRO_FLIGHT_MS });
    this.seated = true;
    if (this.pendingTutorial) {
      this.pendingTutorial = false;
      this.beginTour();
      return;
    }
    this.setInputEnabled(true);
  }

  /**
   * "复原棋局" confirmed: put the recognised / recorded position on the table
   * and go to colour selection. The importer has already run the same reducer,
   * so a rejection here can only mean the settings changed underneath it.
   * @param {import('./ui/PositionImporter.js').ImportedPosition} position
   */
  async enterTableWithPosition(position) {
    const settings = { ...this.startScreen.settings, mode: position.mode ?? this.startScreen.settings.mode };
    this.applyLiveSettings(settings);
    const result = this.engine.loadPosition({
      board: position.board ?? undefined,
      moves: position.moves,
      currentPlayer: position.currentPlayer ?? undefined,
      config: { mode: settings.mode, initialMs: settings.timeMinutes * 60_000 },
    }, now());
    if (result.error) {
      console.warn('[zenith] position rejected:', result.error);
      return;
    }
    this.startScreen.hide();
    this.hud.setSuppressed(false);
    this.menuOpen = false;
    this.pausedByMenu = false;
    this.pendingTutorial = false;
    this.lighting.setMood('play');
    if (this.seated) {
      this.director.returnToMain({ duration: 900 });
    } else {
      await this.director.goTo('MAIN_PLAY', { duration: INTRO_FLIGHT_MS });
      this.seated = true;
    }
    this.setInputEnabled(true);
  }

  /** Esc during play: pause quietly (no clock close-up) and show the sheet in menu mode. */
  openMenu() {
    if (this.menuOpen || !this.seated) return;
    const reviewResume = this.review?.resume ?? false;
    this.endReview(false);
    this.menuOpen = true;
    this.hintRequest++;
    this.manual.setThinking(false);
    this.board.setHover(null);
    this.board.setGhostStones(null);
    this.setInputEnabled(false);
    this.hud.setSuppressed(true);
    const state = this.engine.getState();
    this.pausedByMenu = reviewResume || state.status === GameStatus.PLAYING;
    if (state.status === GameStatus.PLAYING) this.engine.togglePause(now());
    const inGame = state.status === GameStatus.PLAYING || state.status === GameStatus.PAUSED;
    this.startScreen.setMenuContext({ canResign: inGame && state.moves.length > 0, canSave: state.moves.length > 0 || state.setupBoard !== null });
    this.startScreen.setSettings(this.settings);
    this.startScreen.show('menu');
  }

  /** "继续对弈" / Esc again. */
  closeMenu(settings) {
    if (!this.menuOpen) return;
    this.applyLiveSettings(settings);
    this.startScreen.hide();
    this.hud.setSuppressed(false);
    this.menuOpen = false;
    if (this.pausedByMenu && this.engine.status === GameStatus.PAUSED) this.engine.togglePause(now());
    this.pausedByMenu = false;
    this.setInputEnabled(true);
  }

  /** "新对局": rules and time from the sheet, back to colour selection. */
  newGameFromMenu(settings) {
    this.applyLiveSettings(settings);
    this.startScreen.hide();
    this.hud.setSuppressed(false);
    this.menuOpen = false;
    this.pausedByMenu = false;
    this.engine.reset({ mode: settings.mode, initialMs: settings.timeMinutes * 60_000 });
    this.lighting.setMood('play');
    this.director.returnToMain({ duration: 900 });
    this.setInputEnabled(true);
  }

  /** "认输" from the menu: the sheet closes and the seal ceremony follows. */
  resignFromMenu(settings) {
    const state = this.engine.getState();
    if (state.status !== GameStatus.PLAYING && state.status !== GameStatus.PAUSED) return;
    this.closeMenu(settings);
    this.engine.resign(state.humanColor ?? state.currentPlayer, now());
  }

  /** "保存棋谱": download the current game (setup + moves) as a small JSON record. */
  saveRecord() {
    const record = toRecord(this.engine.getState());
    const blob = new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `zenith-${record.savedAt.replace(/[:.]/g, '-').slice(0, 19)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------------------------------------------------------------------------
  // tutorial
  // ---------------------------------------------------------------------------

  /** "新手指导" from the title screen (sit down first) or from the Esc menu (tour, then resume). */
  startTutorial(settings) {
    if (!this.seated) {
      this.pendingTutorial = true;
      this.enterTable(settings).catch(console.error);
      return;
    }
    this.applyLiveSettings(settings);
    this.startScreen.hide();
    this.hud.setSuppressed(false);
    this.menuOpen = false;
    this.tutorialResume = this.pausedByMenu;
    this.pausedByMenu = false;
    this.beginTour();
  }

  beginTour() {
    if (this.tutorial.active) return;
    this.hintRequest++;
    this.manual.setThinking(false);
    this.board.setHover(null);
    this.board.setGhostStones(null);
    this.setInputEnabled(false);
    this.tutorial.start();
  }

  onTutorialStep(step) {
    this.director.goTo(step.view, { duration: TUTORIAL_FLIGHT_MS });
    this.lighting.setMood(step.mood ?? 'play');
    this.spotlight.set(step.spot.map((name) => this.spotTargets[name]).filter(Boolean));
  }

  onTutorialFinished() {
    this.spotlight.clear();
    this.director.returnToMain();
    this.lighting.setMood(this.moodForStatus());
    this.setInputEnabled(true);
    if (this.tutorialResume && this.engine.status === GameStatus.PAUSED) this.engine.togglePause(now());
    this.tutorialResume = false;
  }

  /** Buttons inside bottom captions. */
  onHudAction(id) {
    if (id.startsWith('tutorial:')) {
      this.tutorial.handleAction(id);
      return;
    }
    if (id === 'rematch') {
      const { humanColor, status } = this.engine.getState();
      if (status === GameStatus.FINISHED) this.onBowlClick(humanColor ?? BLACK);
    }
  }

  /** Settings that take effect immediately: sound, AI strength, render quality. */
  applyLiveSettings(settings) {
    this.settings = settings;
    saveSettings(settings);
    this.audio.setMuted(!settings.sound);
    this.applyTier(resolveQuality(settings.quality));
  }

  /**
   * Switch every runtime-adjustable renderer feature to a quality tier
   * (canvas MSAA is the one flag that needs a reload).
   * @param {'high' | 'medium' | 'low'} tier
   */
  applyTier(tier) {
    const profile = QUALITY_PROFILES[tier];
    this.activeTier = tier;
    this.world.setQuality({
      shadows: profile.shadows,
      shadowType: profile.shadowType,
      maxPixelRatio: profile.maxPixelRatio,
      maxPixels: profile.maxPixels,
    });
    this.world.setPostFX(profile.postfx);
    this.lighting.setShadowMapSize(profile.shadowMapSize);
    this.sandglass.setTransmission(profile.transmission);
    this.room.setLanternLights(profile.lanternLights);
    this.room.setShellShading(profile.roomShading);
    // Governor window restarts; the first window is skipped so shader compiles do not count.
    this._governor = { time: 0, frames: 0, skip: 1 };
  }

  /**
   * "自动" safety net: if the measured frame time stays above 40 ms (25 fps) for a
   * whole 3-second window once the player is seated, step down to the low tier.
   * Explicit "精致"/"流畅" choices are respected.
   */
  governQuality(dt) {
    if (!this.seated || this.settings.quality !== 'auto' || this.activeTier === 'low') return;
    const g = this._governor;
    g.time += dt;
    g.frames++;
    if (g.time < 3) return;
    const avgMs = (g.time / g.frames) * 1000;
    if (g.skip > 0) g.skip--;
    else if (avgMs > 40) {
      console.info(`[zenith] ${avgMs.toFixed(0)} ms/frame on "${this.activeTier}" — auto quality stepping down to low`);
      this.applyTier('low');
      return;
    }
    g.time = 0;
    g.frames = 0;
  }

  setInputEnabled(enabled) {
    this.interactions.setEnabled(enabled);
    this.orbitInput.setEnabled(enabled);
  }

  onKeyDown(event) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (this.startScreen.visible) {
      if (event.key !== 'Escape') return;
      if (this.startScreen.mode === 'import') this.startScreen.back();
      else if (this.startScreen.mode === 'menu') this.closeMenu(this.startScreen.settings);
      return;
    }
    if (this.tutorial.active) {
      if (event.key === 'Escape') this.tutorial.skip();
      else if (event.key === 'Enter' || event.key === 'ArrowRight') this.tutorial.next();
      else if (event.key === 'ArrowLeft') this.tutorial.prev();
      return;
    }
    if (!this.seated) return;
    if (this.review) {
      const indices = { ArrowLeft: this.review.index - 1, ArrowRight: this.review.index + 1, Home: 0, End: this.engine.moves.length };
      if (event.key in indices) {
        event.preventDefault();
        this.showReviewMove(indices[event.key]);
        return;
      }
      if (event.key === 'Escape' || event.key === ' ') {
        event.preventDefault();
        this.endReview();
        return;
      }
    }
    switch (event.key) {
      case 'Escape':
        if (!this.ceremonyBusy) this.openMenu();
        break;
      case 'z':
      case 'Z':
        this.onSandglassClick();
        break;
      case 'h':
      case 'H':
        this.onManualClick().catch(console.error);
        break;
      case ' ': {
        const { status } = this.engine.getState();
        if (status === GameStatus.PLAYING || status === GameStatus.PAUSED) {
          event.preventDefault();
          this.engine.togglePause(now());
        }
        break;
      }
      default:
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // per-frame
  // ---------------------------------------------------------------------------

  syncClock(dt) {
    this.engine.tick(now());
    const state = this.engine.getState();
    const { clock } = state;
    if (clock.initialMs > 0) {
      this.clock.setTimes(clock.black, clock.white);
      return;
    }
    // Untimed: the dials become stopwatches of each side's thinking time.
    if (state.status === GameStatus.PLAYING) this.elapsedMs[state.currentPlayer] += dt * 1000;
    this.clock.setTimes(this.elapsedMs[BLACK], this.elapsedMs[WHITE]);
  }

  updateCameraAndServices(dt, elapsed) {
    this.director.update(dt);
    this.shake.update(dt);
    this.shake.apply(this.world.camera);
    this.lighting.update(dt);
    this.interactions.update();
    this.spotlight.update(elapsed);
    this.updateFigures();
    this.audio.update();
    this.debugStats?.update(dt);
    this.governQuality(dt);
    this.syncTableConsole();
  }

  persistSession(force = false) {
    if (this.restoringSession || (!force && now() - this.lastSessionSave < 5000)) return;
    this.lastSessionSave = now();
    this.sessions.save(this.engine.getState(), this.elapsedMs);
  }

  async resumeSavedGame() {
    if (this.restoringSession || !this.savedSession) return;
    this.restoringSession = true;
    const saved = this.savedSession;
    try {
      this.applyLiveSettings({ ...this.settings, mode: saved.game.mode, timeMinutes: saved.game.clock.initialMs / 60_000 });
      const result = this.engine.restoreSession(saved.game, now());
      if (result.error) return;
      this.elapsedMs = { ...saved.elapsedMs };
      this.pendingTutorial = false;
      this.startScreen.hide();
      this.hud.clear();
      await this.director.goTo('MAIN_PLAY', { duration: INTRO_FLIGHT_MS });
      this.seated = true;
      this.setInputEnabled(true);
      this.engine.togglePause(now());
    } finally {
      this.restoringSession = false;
      this.persistSession(true);
    }
  }

  syncTableConsole() {
    const s = this.engine.getState();
    const selecting = s.status === GameStatus.SELECTING;
    const finished = s.status === GameStatus.FINISHED;
    const active = s.status === GameStatus.PLAYING || s.status === GameStatus.PAUSED;
    const action = (id, label, enabled = true) => ({ id, label, enabled });
    if (this.review) {
      const i = this.review.index;
      const move = s.moves[i - 1];
      this.tableConsole.setState(`复盘 · ${i} / ${s.moves.length} 手`, move ? `${SIDE_NAME[move.player]} ${move.notation} · 淡子为后续着法` : '起始局面 · 淡子为后续着法', [
        action('first', '起始', i > 0), action('prev', '上一手', i > 0),
        action('next', '下一手', i < s.moves.length), action('last', '末手', i < s.moves.length),
        action('exitReview', '返回对局'), action('menu', '设置'),
      ]);
      return;
    }
    const title = selecting ? '揭罐选边 · 请入局' : finished ? '此局已终 · 可复盘再战'
      : s.status === GameStatus.PAUSED ? '对局暂停' : this.engine.isAiTurn() ? '对手思考中' : `轮到你 · 执${SIDE_NAME[s.humanColor]}`;
    const detail = `${s.rules.mode === 'RENJU' ? '连珠禁手' : '标准五子'} · 第 ${s.moves.length} 手`;
    this.tableConsole.setState(title, detail, [
      selecting || finished ? action('black', '执黑') : action('pause', s.status === GameStatus.PAUSED ? '继续' : '暂停', active && !this.busy),
      selecting || finished ? action('white', '执白') : action('undo', '悔棋', s.moves.length > 0 && !this.busy),
      action('hint', '请教', this.engine.isHumanTurn() && !this.busy),
      action('review', '棋谱', s.moves.length > 0 && !this.busy),
      action('view', this.director.current === 'BOARD_STUDY' ? '落座' : '俯览', !this.busy),
      action('menu', '设置', !this.ceremonyBusy),
    ]);
  }

  onTableAction(id) {
    if (this.menuOpen || this.tutorial.active || this.ceremonyBusy) return;
    switch (id) {
      case 'black': this.onBowlClick(BLACK); break;
      case 'white': this.onBowlClick(WHITE); break;
      case 'pause': this.onPlungerClick(); break;
      case 'undo': this.onSandglassClick(); break;
      case 'hint': this.onManualClick().catch(console.error); break;
      case 'review': this.beginReview(); break;
      case 'first': this.showReviewMove(0); break;
      case 'prev': this.showReviewMove((this.review?.index ?? 1) - 1); break;
      case 'next': this.showReviewMove((this.review?.index ?? 0) + 1); break;
      case 'last': this.showReviewMove(this.engine.moves.length); break;
      case 'exitReview': this.endReview(); break;
      case 'view': this.focus(this.director.current === 'BOARD_STUDY' ? 'MAIN_PLAY' : 'BOARD_STUDY'); break;
      case 'menu': this.openMenu(); break;
    }
  }

  /** The player's right hand holds the ledger pen while it writes; heads hide when the camera is inside them. */
  updateFigures() {
    const penInHand = this.ledger.penInHand;
    if (penInHand) {
      this.ledger.getPenGrip(this._penGrip, this._penDir);
      this.player.holdAt('right', this._penGrip, this._penDir);
    } else if (this._penHeld) {
      this.player.holdAt('right', null);
    }
    this._penHeld = penInHand;

    const cam = this.world.camera.getWorldPosition(this._camPos);
    for (const figure of [this.player, this.opponent]) {
      const near = figure.getHeadWorldPosition(this._headPos).distanceTo(cam) < 3.2;
      figure.setFirstPerson(near);
    }
  }

  /** Contemplative pose for the opponent while its search runs (idempotent). */
  setOpponentThinking(active) {
    if (this.opponentThinking === active) return;
    this.opponentThinking = active;
    if (active) this.opponent.setThinking(true, { hand: 'right', hoverAt: this.tray.getPickPosition() });
    else this.opponent.setThinking(false);
  }

  /**
   * A committed move is carried to the board by a hand; the real stone drops
   * only when the hand opens above the cell. Resolves when it has landed (or the
   * gesture was cancelled by an undo / reset).
   */
  carryStone(move, isAi) {
    const key = `${move.row},${move.col}`;
    const figure = isAi ? this.opponent : this.player;
    const hand = isAi ? 'right' : move.player === BLACK ? 'left' : 'right';
    const arms = isAi ? this.opponentArms : this.playerArms;
    // Moves arriving faster than an arm can carry them (scripted sequences): the stone still in that
    // hand lands at once, because the new gesture supersedes the old one without releasing it.
    if (arms[hand]) this.landStone(arms[hand], { immediate: true });
    arms[hand] = key;

    let land = () => {};
    const promise = new Promise((resolve) => {
      land = resolve;
    });
    this.carrying.set(key, { move, promise, land });
    if (isAi) this.setOpponentThinking(false);
    figure.playStone({
      hand,
      from: isAi ? this.tray.getPickPosition() : this.bowls.getBowlPosition(move.player),
      to: this.board.getStoneWorldPosition(move.row, move.col),
      player: move.player,
      onRelease: () => this.landStone(key),
      speed: isAi ? 1 : 1.35,
    }).catch(console.error);
    return promise;
  }

  /** The hand has opened above the cell: drop the real stone, record the move, free the arm. */
  landStone(key, { immediate = false } = {}) {
    const entry = this.carrying.get(key);
    if (!entry) return;
    this.carrying.delete(key);
    for (const arms of [this.playerArms, this.opponentArms]) {
      for (const hand of ['left', 'right']) if (arms[hand] === key) arms[hand] = null;
    }
    const { move } = entry;
    this.board.placeStone(move.row, move.col, move.player, { dropHeight: immediate ? 0.4 : 1.2 }).catch(console.error);
    // A whisper of camera shake when the stone hits the board sells its weight.
    setTimeout(() => this.shake.trigger({ amplitude: 0.045, decayMs: 140, frequency: 34 }), immediate ? 60 : 120);
    // The player records the move once the stone is down.
    this.ledger.writeMove(move.index, move.notation, move.player).catch(console.error);
    entry.land();
  }

  /** Drop pending carries (undo / reset): their stones must never land afterwards. */
  cancelCarries() {
    for (const { land } of this.carrying.values()) land();
    this.carrying.clear();
    this.playerArms = { left: null, right: null };
    this.opponentArms = { left: null, right: null };
    this.player.cancelGestures();
    this.opponent.cancelGestures();
  }

  // ---------------------------------------------------------------------------
  // input wiring
  // ---------------------------------------------------------------------------

  bindInteractions() {
    const im = this.interactions;
    im.registerEntity(this.tableConsole, {
      table_console: {
        onClick: (hit) => this.onTableAction(this.tableConsole.actionAt(hit.intersection)),
        onHoverMove: (hit) => this.tableConsole.setHover(this.tableConsole.actionAt(hit.intersection)),
        onHoverExit: () => this.tableConsole.setHover(null),
      },
    });
    im.registerEntity(this.tabletop, {
      [INTERACTIVE.TABLE]: { onClick: () => this.escape() },
    });
    im.registerEntity(this.board, {
      [INTERACTIVE.BOARD]: {
        onClick: (hit) => this.onBoardClick(hit),
        onHoverEnter: (hit) => this.onBoardHover(hit),
        onHoverMove: (hit) => this.onBoardHover(hit),
        onHoverExit: () => this.board.setHover(null),
      },
    });
    im.registerEntity(this.bowls, {
      [INTERACTIVE.BOWL_BLACK]: { onClick: () => this.onBowlClick(BLACK) },
      [INTERACTIVE.BOWL_WHITE]: { onClick: () => this.onBowlClick(WHITE) },
    });
    im.registerEntity(this.clock, {
      [INTERACTIVE.CLOCK_PLUNGER]: { onClick: () => this.onPlungerClick() },
      [INTERACTIVE.CLOCK_BODY]: { onClick: () => this.focus('CLOCK_FOCUS') },
    });
    im.registerEntity(this.sandglass, {
      [INTERACTIVE.SANDGLASS]: { onClick: () => this.onSandglassClick() },
    });
    im.registerEntity(this.manual, {
      [INTERACTIVE.MANUAL]: { onClick: () => this.onManualClick().catch(console.error) },
    });
    im.registerEntity(this.ledger, {
      [INTERACTIVE.LEDGER_PAGE]: {
        onClick: (hit) => this.onLedgerClick(hit),
        onHoverEnter: (hit) => this.onLedgerHover(hit),
        onHoverMove: (hit) => this.onLedgerHover(hit),
        onHoverExit: () => this.board.setGhostStones(this.review?.index ?? null, this.engine.moves),
      },
      [INTERACTIVE.LEDGER_NEXT]: { onClick: () => this.onLedgerPage(1) },
      [INTERACTIVE.LEDGER_PREV]: { onClick: () => this.onLedgerPage(-1) },
    });
    im.registerEntity(this.stamp, {
      [INTERACTIVE.STAMP]: { onClick: () => this.escape() },
    });
    im.setBackgroundHandler(() => this.escape());
  }

  bindAudioUnlock(canvas) {
    const unlock = () => this.audio.unlock().catch(() => {});
    canvas.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    window.addEventListener('pointerdown', unlock, { once: true, capture: true });
  }

  // ---------------------------------------------------------------------------
  // camera helpers
  // ---------------------------------------------------------------------------

  /** Push the camera into a prop close-up (spec §3.1). */
  focus(viewpoint, mood = null) {
    this.director.goTo(viewpoint);
    if (mood) this.lighting.setMood(mood);
  }

  /** Escape gesture (spec §3.2): a click on empty table space returns to MAIN_PLAY and undoes any free-look. */
  escape() {
    this.endReview();
    this.hintRequest++;
    this.manual.setThinking(false);
    this.board.setGhostStones(null);
    if (this.director.current !== 'MAIN_PLAY' || this.director.hasUserOrbit) this.director.returnToMain();
    this.lighting.setMood(this.moodForStatus());
  }

  moodForStatus() {
    const { status } = this.engine.getState();
    if (status === GameStatus.PAUSED) return 'paused';
    if (status === GameStatus.FINISHED) return 'victory';
    return 'play';
  }

  // ---------------------------------------------------------------------------
  // pointer handlers
  // ---------------------------------------------------------------------------

  onBowlClick(color) {
    const { status } = this.engine.getState();
    if (status === GameStatus.SELECTING || status === GameStatus.FINISHED) {
      if (this.ceremonyBusy) return;
      this.engine.selectColor(color, now());
    } else {
      this.escape();
    }
  }

  onBoardClick(hit) {
    if (this.review) { this.endReview(); return; }
    const cell = this.board.pointToCell(hit.point);
    if (!cell || !['MAIN_PLAY', 'BOARD_STUDY'].includes(this.director.current) || this.engine.status !== GameStatus.PLAYING) {
      this.escape();
      return;
    }
    if (!this.engine.isHumanTurn() || this.busy || this.board.hasStone(cell.row, cell.col)) return;
    this.engine.makeMove(cell.row, cell.col, now());
  }

  onBoardHover(hit) {
    const canPlay = this.engine.isHumanTurn() && !this.busy && ['MAIN_PLAY', 'BOARD_STUDY'].includes(this.director.current) && !this.orbitInput.isDragging;
    this.board.setHover(canPlay ? this.board.pointToCell(hit.point) : null, this.engine.getState().humanColor ?? BLACK);
  }

  onPlungerClick() {
    const { status } = this.engine.getState();
    if (status === GameStatus.PLAYING || status === GameStatus.PAUSED) this.engine.togglePause(now());
    else this.focus('CLOCK_FOCUS');
  }

  onSandglassClick() {
    this.endReview();
    const state = this.engine.getState();
    if (this.busy || this.sandglass.busy || state.status === GameStatus.SELECTING || state.moves.length === 0) return;
    this.cancelAi();
    // Rewind to the human's turn: also take back the AI reply when it moved last.
    const last = state.moves[state.moves.length - 1];
    const count = state.aiColor != null && last.player === state.aiColor && state.moves.length >= 2 ? 2 : 1;
    this.engine.undo(count, now());
  }

  async onManualClick() {
    this.focus('MANUAL_STUDY', 'study');
    const state = this.engine.getState();
    if (state.status !== GameStatus.PLAYING || !this.engine.isHumanTurn() || this.busy) return;

    const request = ++this.hintRequest;
    this.manual.setThinking(true);
    await sleep(300); // a beat of brush-dipping before the answer arrives from the worker
    if (request !== this.hintRequest) return;

    const advice = await this.coach.getAdvice(state);
    if (request !== this.hintRequest) return;
    const current = this.engine.getState();
    this.manual.setThinking(false);
    if (current.moves.length !== state.moves.length || current.status !== GameStatus.PLAYING) return;

    this.manual.showAdvice(advice).catch(console.error);
    if (advice.move) this.board.showHint(advice.move.row, advice.move.col);
  }

  onLedgerHover(hit) {
    if (this.director.current !== 'LEDGER_REVIEW') return;
    const index = this.ledger.hitToMoveIndex(hit.intersection);
    this.board.setGhostStones(index == null ? this.review?.index ?? null : index + 1, this.engine.getState().moves);
  }

  beginReview(viewpoint = 'BOARD_STUDY') {
    const state = this.engine.getState();
    if (this.busy || state.moves.length === 0 || this.menuOpen) return;
    if (!this.review) {
      this.review = { index: state.moves.length, resume: state.status === GameStatus.PLAYING };
      this.hintRequest++;
      this.manual.setThinking(false);
      this.cancelAi();
      for (const key of [...this.carrying.keys()]) this.landStone(key, { immediate: true });
      this.ledger.setMoves(state.moves);
      if (this.review.resume) this.engine.togglePause(now());
    }
    this.showReviewMove(this.review.index);
    this.focus(viewpoint, 'study');
  }

  showReviewMove(index) {
    if (!this.review) return;
    this.review.index = Math.max(0, Math.min(this.engine.moves.length, index));
    this.board.setGhostStones(this.review.index, this.engine.moves);
    this.ledger.setReviewIndex(this.review.index);
  }

  endReview(resume = true) {
    if (!this.review) return;
    const shouldResume = this.review.resume;
    this.review = null;
    this.board.setGhostStones(null);
    this.ledger.setReviewIndex(null);
    if (resume && shouldResume && this.engine.status === GameStatus.PAUSED) this.engine.togglePause(now());
    if (resume) {
      this.director.returnToMain();
      this.lighting.setMood(this.moodForStatus());
    }
  }

  onLedgerClick(hit) {
    if (this.director.current !== 'LEDGER_REVIEW') { this.beginReview('LEDGER_REVIEW'); return; }
    const index = this.ledger.hitToMoveIndex(hit.intersection);
    if (index == null) return;
    this.beginReview();
    this.showReviewMove(index + 1);
  }

  onLedgerPage(direction) {
    if (!this.review) this.beginReview('LEDGER_REVIEW');
    if (this.director.current !== 'LEDGER_REVIEW') this.focus('LEDGER_REVIEW', 'study');
    (direction > 0 ? this.ledger.nextPage() : this.ledger.prevPage()).catch(console.error);
  }

  // ---------------------------------------------------------------------------
  // engine events → props
  // ---------------------------------------------------------------------------

  enterSelection() {
    this.bowls.setSelectable(true);
    this.board.setInteractive(false);
    this.sandglass.setEnabled(false);
    this.sandglass.setFlowing(false);
    this.clock.setRunning(false);
    this.clock.setPaused(false);
    this.clock.setActivePlayer(null);
    this.lighting.setMood('play');
  }

  onGameReset() {
    this.gameEpoch++;
    this.undoBusy = false;
    this.endReview(false);
    this.cancelAi();
    this.cancelCarries();
    this.hintRequest++;
    this.elapsedMs = { [BLACK]: 0, [WHITE]: 0 };
    this.hud.clear();
    this.tray.setColor(null);
    this.opponent.lookAt(this.player.getHeadWorldPosition(this._headPos).clone());
    this.stamp.reset();
    this.board.clearStones();
    this.board.clearHighlight();
    this.board.clearHint();
    this.board.setGhostStones(null);
    this.ledger.setMoves([]);
    this.manual.clear();
    this.manual.setThinking(false);
    this.bowls.closeLids().catch(console.error);
    this.enterSelection();
  }

  /** Restored position: stones appear in place (no drop animation), the ledger shows any replayed moves. */
  onPositionLoaded({ currentPlayer, counts, moves }, state) {
    this.board.setStones(state.board);
    this.ledger.setMoves(state.moves);
    this.sandglass.setEnabled(false);
    const side = SIDE_NAME[currentPlayer];
    this.hud.set('center', {
      title: `局面已复原 · 轮到${side}方`,
      text: `黑 ${counts.black} 子 · 白 ${counts.white} 子${moves.length ? ` · 棋谱 ${moves.length} 手` : ''}。揭开左侧黑罐执黑，或右侧白罐执白，另一方由 AI 接手。`,
    });
  }

  onColorSelected({ humanColor, aiColor }, state) {
    this.elapsedMs = { [BLACK]: 0, [WHITE]: 0 };
    this.hud.clear();
    this.bowls.setSelectable(false);
    this.bowls.openLid(humanColor).catch(console.error);
    this.tray.setColor(aiColor);
    this.updateGaze(state.currentPlayer);
    this.board.setInteractive(true);
    this.clock.setPaused(false);
    this.clock.setRunning(true);
    this.clock.setActivePlayer(state.currentPlayer);
    this.sandglass.setFlowing(true);
    // A restored record may already carry moves that can be taken back.
    this.sandglass.setEnabled(state.moves.length > 0);
    this.lighting.setMood('play');
    if (this.director.current !== 'MAIN_PLAY') this.director.returnToMain();
    this.scheduleAi();
  }

  onMoveCommitted({ move }, state) {
    this.board.setHover(null);
    this.board.clearHint();
    this.carryStone(move, move.player === state.aiColor);
    this.sandglass.setEnabled(true);
  }

  onTurnSwitched({ currentPlayer }) {
    this.clock.setActivePlayer(currentPlayer);
    this.updateGaze(currentPlayer);
    this.scheduleAi();
  }

  /** The opponent studies the board on its own turn and watches the player during theirs. */
  updateGaze(currentPlayer) {
    const { aiColor } = this.engine.getState();
    if (currentPlayer === aiColor) this.opponent.lookAt(new Vector3(0, BOARD_TOP_Y, 0));
    else this.opponent.lookAt(this.player.getHeadWorldPosition(new Vector3()));
    this.player.lookAt(new Vector3(0, BOARD_TOP_Y, 0));
  }

  onPauseToggled({ paused }) {
    this.clock.setPaused(paused);
    this.sandglass.setFlowing(!paused);
    this.board.setInteractive(!paused);
    this.board.setHover(null);
    this.lighting.setMood(paused ? 'paused' : 'play');
    if (paused) {
      this.cancelAi();
      // The Esc menu pauses too, but keeps the camera where the player left it.
      if (!this.menuOpen && !this.review) this.director.goTo('CLOCK_FOCUS', { duration: 650 });
    } else {
      if (!this.menuOpen) this.director.returnToMain();
      this.scheduleAi();
    }
  }

  async onStateReverted({ undoneMoves }, state) {
    const epoch = this.gameEpoch;
    this.undoBusy = true;
    this.hintRequest++;
    this.cancelCarries();
    this.hud.clear();
    this.stamp.reset();
    this.board.clearHighlight();
    this.board.clearHint();
    this.board.setGhostStones(null);
    this.manual.clear();
    this.manual.setThinking(false);
    this.ledger.setMoves(state.moves);
    this.clock.setActivePlayer(state.currentPlayer);
    this.clock.setRunning(state.status === GameStatus.PLAYING);
    this.lighting.setMood(this.moodForStatus());
    if (this.director.current === 'VICTORY_DRAMA') this.director.returnToMain();

    // Spec §2.2 timeline: the glass flips at T=0, stones lift at T≈200ms and glide back to their bowls.
    const flip = this.sandglass.flip();
    const flights = undoneMoves.map(async (move, i) => {
      await sleep(200 + i * 140);
      if (epoch !== this.gameEpoch) return;
      await this.board.removeStone(move.row, move.col, { flyTo: this.bowls.getBowlPosition(move.player) });
    });
    await Promise.all([flip, ...flights]);
    if (epoch !== this.gameEpoch) return;

    this.undoBusy = false;
    this.sandglass.setEnabled(this.engine.getState().moves.length > 0);
    this.updateGaze(this.engine.currentPlayer);
    this.scheduleAi();
  }

  async onGameFinished(payload, state) {
    const { winner, winLine } = payload;
    this.cancelAi();
    this.hintRequest++;
    this.ceremonyBusy = true;
    this.hud.clear();
    this.board.setHover(null);
    this.board.clearHint();
    this.board.setInteractive(false);
    this.manual.setThinking(false);
    this.clock.setRunning(false);
    this.clock.setActivePlayer(null);
    this.sandglass.setFlowing(false);
    this.lighting.setMood('victory');

    const result = winner === 'DRAW' ? 'DRAW' : winner === state.humanColor ? 'WIN' : 'LOSS';
    this.recordResult(result, state);

    // The deciding stone may still be in a hand: wait for it to land before the highlight and the seal.
    const last = state.moves[state.moves.length - 1];
    const carry = last ? this.carrying.get(`${last.row},${last.col}`) : null;
    if (carry) await Promise.race([carry.promise, sleep(2500)]);
    if (this.engine.status !== GameStatus.FINISHED) {
      this.ceremonyBusy = false;
      return;
    }
    this.opponent.lookAt(new Vector3(0, BOARD_TOP_Y, 0));

    const focusCells = winLine ?? state.moves.slice(-1);
    const centre = cellsCenterWorld(focusCells);
    if (winLine) this.board.highlightWinLine(winLine);

    // Let the final stone settle, then pull up to the 80° overview aimed at the winning line.
    await sleep(380);
    this.director.goTo('VICTORY_DRAMA', { duration: 800, target: [centre.x, BOARD_TOP_Y, centre.z] });

    // Seal lands on the board quadrant opposite the winning line so it never hides the five.
    const side = (v) => (v > 0 ? -2.1 : 2.1);
    await this.stamp.ceremony({
      text: SEAL_TEXT[result],
      chime: result === 'LOSS' ? 'chime_lose' : 'chime_win',
      target: [side(centre.x), BOARD_TOP_Y + 0.25, side(centre.z)],
      onImpact: () => this.shake.trigger({ amplitude: 0.25, decayMs: 200 }),
    });

    this.ceremonyBusy = false;
    // Either bowl starts a fresh game; the sandglass takes the last move back instead.
    this.bowls.setSelectable(true);
    if (this.engine.status === GameStatus.FINISHED) {
      this.showEndgameHints(result, payload, state);
      // A courteous bow across the table, whoever won; a nod for a draw.
      this.opponent.lookAt(this.player.getHeadWorldPosition(new Vector3()));
      (result === 'DRAW' ? this.opponent.nod() : this.opponent.bow()).catch(console.error);
    }
  }

  /** Human-readable cause of the result for the end-of-game caption. */
  describeFinish({ winner, reason, forbidden, resigned }) {
    switch (reason) {
      case FinishReason.FIVE: return `${SIDE_NAME[winner]}方五子连珠`;
      case FinishReason.FORBIDDEN: return `黑方禁手 · ${FORBIDDEN_NAME[forbidden] ?? '违例'}`;
      case FinishReason.TIMEOUT: return `${SIDE_NAME[opponentOf(winner)]}方超时`;
      case FinishReason.RESIGN: return `${SIDE_NAME[resigned ?? opponentOf(winner)]}方认输`;
      case FinishReason.DRAW: return '棋盘已满';
      default: return '终局';
    }
  }

  /**
   * Bottom captions after the seal has landed: the bowls are on the left (black)
   * and right (white) of the board, so each side of the screen points at the bowl
   * that starts the next game with that colour.
   */
  showEndgameHints(result, payload, state) {
    const human = state.humanColor ?? BLACK;
    this.hud.set('left', { arrow: 'left', title: '执黑再战', text: '揭开左侧黑胡桃木棋罐 · 黑先行' });
    this.hud.set('right', { arrow: 'right', title: '执白再战', text: '揭开右侧白蜡木棋罐 · 白后行' });
    this.hud.set('center', {
      title: `${SEAL_TEXT[result]} · ${this.describeFinish(payload)}`,
      text: '点沙漏可收回最后一手复盘 · Esc 可保存棋谱、调整规则或棋力',
      actions: [{ id: 'rematch', label: `同执${SIDE_NAME[human]}再来一局`, primary: true }],
    });
  }

  recordResult(result, state) {
    if (state.humanColor == null) return;
    const key = result === 'WIN' ? 'wins' : result === 'LOSS' ? 'losses' : 'draws';
    this.stats = { ...this.stats, [key]: this.stats[key] + 1 };
    saveStats(this.stats);
    this.startScreen.setStats(this.stats);
  }

  // ---------------------------------------------------------------------------
  // AI opponent
  // ---------------------------------------------------------------------------

  cancelAi() {
    this.aiRequest++;
    if (this.aiTimer !== null) {
      clearTimeout(this.aiTimer);
      this.aiTimer = null;
    }
    this.setOpponentThinking(false);
  }

  /**
   * Queue the AI reply when it is the machine's turn. The search runs in the
   * worker; the position is re-validated both when the timer fires and when the
   * result arrives, since an undo or pause may have intervened.
   */
  scheduleAi() {
    this.cancelAi();
    if (!this.engine.isAiTurn()) return;
    // The opponent's hand drifts to its dish while the search runs, so the pick is quick once the move is decided.
    if (!this.busy) this.setOpponentThinking(true);
    const expectedMoves = this.engine.getState().moves.length;
    const token = this.aiRequest;
    this.aiTimer = setTimeout(() => {
      this.aiTimer = null;
      const state = this.engine.getState();
      if (token !== this.aiRequest || !this.engine.isAiTurn() || state.moves.length !== expectedMoves) return;
      if (this.busy) {
        this.scheduleAi();
        return;
      }
      this.ai
        .findBestMove(state, { depth: this.settings.aiDepth, timeLimitMs: AI_TIME_LIMIT_MS, randomize: true })
        .then((best) => {
          if (token !== this.aiRequest) return;
          const current = this.engine.getState();
          if (!this.engine.isAiTurn() || current.moves.length !== expectedMoves) return;
          if (this.busy || !best) {
            this.scheduleAi();
            return;
          }
          this.engine.makeMove(best.row, best.col, now());
        })
        .catch((err) => console.error('[zenith] AI search failed:', err));
    }, AI_THINK_DELAY_MS);
  }

  dispose() {
    this.cancelAi();
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('pagehide', this._onPageHide);
    document.removeEventListener('visibilitychange', this._onVisibilityChange);
    for (const off of this.unsubscribers) off();
    this.debugStats?.dispose();
    this.tutorial.dispose();
    this.spotlight.clear();
    this.hud.dispose();
    this.importer.dispose();
    this.startScreen.dispose();
    this.orbitInput.dispose();
    this.interactions.dispose();
    this.ai.dispose();
    this.audio.dispose();
    this.lighting.dispose();
    this.world.dispose();
  }
}

async function boot() {
  const canvas = document.getElementById('webgl');
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Missing <canvas id="webgl">');
  const debug = new URLSearchParams(location.search).get('debug') === '1';

  // Calligraphy fonts must be registered before the entities paint their canvases.
  const assets = new AssetLibrary();
  await assets.init({ timeoutMs: 3500 });

  const app = new ZenithApp(canvas, loadSettings(), { debug, assets });
  document.getElementById('boot')?.remove();
  globalThis.zenith = app;
  if (import.meta.hot) import.meta.hot.dispose(() => app.dispose());
  return app;
}

if (typeof document !== 'undefined') boot().catch(console.error);
