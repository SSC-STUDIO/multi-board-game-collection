/** Video-only art direction and capture. It never changes the shipped game UI. */
export async function installPromo(app, { width = 1080, height = 1920 } = {}) {
  await document.fonts.ready;
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  const state = { cue: null, start: 0, chunks: [], frameCount: 0, firstPerson: true, timeline: [] };
  const font = '"Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
  const gold = '#e4c38c', white = '#fff6e7';
  const paintText = (text, x, y, size, color = white, weight = 500) => {
    ctx.font = `${weight} ${size}px ${font}`;
    ctx.fillStyle = color; ctx.fillText(text, x, y, 930);
  };
  const originalRender = app.world.render.bind(app.world);
  const originalFigures = app.updateFigures.bind(app);
  app.updateFigures = () => { originalFigures(); if (state.firstPerson) app.player.setFirstPerson(true); };
  const compose = () => {
    ctx.drawImage(app.world.canvas, 0, 0, width, height);
    const seconds = (performance.now() - state.start) / 1000;
    const cue = state.cue;
    const top = ctx.createLinearGradient(0, 0, 0, 440);
    top.addColorStop(0, 'rgba(13,10,8,.78)'); top.addColorStop(1, 'rgba(13,10,8,0)');
    ctx.fillStyle = top; ctx.fillRect(0, 0, width, 440);
    const bottom = ctx.createLinearGradient(0, 1580, 0, 1920);
    bottom.addColorStop(0, 'rgba(13,10,8,0)'); bottom.addColorStop(1, 'rgba(13,10,8,.92)');
    ctx.fillStyle = bottom; ctx.fillRect(0, 1580, width, 340);
    paintText('ZENITH  /  TABLETOP 3D', 74, 93, 27, gold, 600);
    ctx.fillStyle = gold; ctx.fillRect(74, 119, 70, 3);
    if (cue) {
      const age = seconds - cue.at;
      const fade = Math.min(1, Math.max(0, age / .65));
      ctx.save(); ctx.globalAlpha = fade; ctx.translate(0, (1 - fade) * 18);
      if (cue.type === 'intro') {
        const shade = ctx.createLinearGradient(0, 150, 0, 850);
        shade.addColorStop(0, 'rgba(12,9,7,.55)'); shade.addColorStop(1, 'rgba(12,9,7,0)');
        ctx.fillStyle = shade; ctx.fillRect(0, 150, width, 700);
        paintText('巅峰棋道', 70, 337, 116, white, 700);
        paintText('把一局棋，下成一段时光。', 77, 426, 42, gold);
        paintText('3D 棋室  ·  完整实战', 77, 496, 30, '#efe1cc');
      } else if (cue.type === 'outro') {
        ctx.fillStyle = 'rgba(12,9,7,.66)'; ctx.fillRect(0, 145, width, 1490);
        paintText('下一局，', 76, 534, 91, white, 700);
        paintText('轮到你。', 76, 651, 91, white, 700);
        paintText('人机对弈   /   战术提示', 80, 807, 39, gold);
        paintText('暂停悔棋   /   逐手复盘', 80, 884, 39, gold);
        paintText('Zenith Tabletop 3D', 80, 1089, 48, white, 600);
        paintText('SSC-STUDIO /', 82, 1174, 29, '#d9cbb6');
        paintText('Zenith-Tabletop-3D', 82, 1222, 33, '#d9cbb6');
        paintText('开源 · 浏览器即开即玩', 82, 1398, 33, gold);
      } else {
        paintText(cue.title, 74, 215, 63, white, 700);
        paintText(cue.subtitle ?? '', 77, 278, 32, gold);
      }
      paintText(cue.caption ?? '', 76, 1758, 39, white, 500);
      ctx.restore();
    }
    if (app.engine.moves.length && state.cue?.type !== 'outro') {
      const move = app.engine.moves.at(-1);
      const count = app.review?.index ?? app.engine.moves.length;
      const label = app.review ? `逐手复盘  ·  ${count} / ${app.engine.moves.length} 手`
        : `完整对局  ·  第 ${count} 手  ·  ${move.player === 1 ? '黑' : '白'} ${move.notation}`;
      paintText(label, 76, 1834, 29, gold, 500);
      ctx.fillStyle = 'rgba(255,246,230,.16)'; ctx.fillRect(76, 1865, 928, 3);
      ctx.fillStyle = gold; ctx.fillRect(76, 1865, 928 * Math.min(1, count / 21), 3);
    } else paintText('ZENITH TABLETOP 3D', 76, 1834, 25, '#d7c5aa');
    state.frameCount++;
  };
  app.world.render = () => { originalRender(); compose(); };

  const cue = (title, subtitle = '', caption = '', type = '') => {
    const entry = { title, subtitle, caption, type, at: (performance.now() - state.start) / 1000 };
    state.cue = entry; state.timeline.push(entry);
  };
  await app.audio.unlock(); app.audio.setMuted(false);
  const audio = app.audio.context, destination = audio.createMediaStreamDestination();
  app.audio._master.connect(destination);
  // An original sparse pentatonic score, mixed underneath the game's own positional sounds.
  function score() {
    const bus = audio.createGain(); bus.gain.value = .14; bus.connect(destination);
    const notes = [146.832, 174.614, 195.998, 220, 261.626, 293.665, 349.228, 391.995];
    const melody = [0, 4, 3, 2, 5, 3, 4, 1, 0, 2, 4, 6, 5, 3, 2, 4];
    const beginning = audio.currentTime + .1;
    const tone = (freq, start, amp, duration) => {
      for (const [ratio, gain, decay] of [[1, 1, 1], [2, .23, .62], [3.01, .08, .4]]) {
        const oscillator = audio.createOscillator(), envelope = audio.createGain();
        oscillator.type = 'sine'; oscillator.frequency.value = freq * ratio;
        envelope.gain.setValueAtTime(0, start);
        envelope.gain.linearRampToValueAtTime(amp * gain, start + .018);
        envelope.gain.exponentialRampToValueAtTime(.0001, start + duration * decay);
        oscillator.connect(envelope); envelope.connect(bus);
        oscillator.start(start); oscillator.stop(start + duration * decay + .05);
      }
    };
    for (let i = 0; i < 125; i++) {
      const start = beginning + i * 2.4;
      tone(notes[melody[i % melody.length]], start, .28, 3.2);
      if (i % 4 === 0) {
        tone(73.416, start, .10, 8.5); tone(110, start + .12, .06, 7.5);
      }
      if (i % 8 === 6) tone(notes[melody[(i + 3) % melody.length]] * 2, start + 1.2, .065, 1.8);
    }
  }
  return {
    state, canvas, cue,
    async start() {
      state.start = performance.now(); state.timeline = []; state.frameCount = 0;
      const stream = canvas.captureStream(30);
      for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);
      const mimeType = ['video/mp4;codecs=avc1.64002a,mp4a.40.2', 'video/webm;codecs=vp8,opus']
        .find(type => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 16_000_000, audioBitsPerSecond: 192_000 });
      state.recorder = recorder;
      recorder.ondataavailable = event => { if (event.data.size) state.chunks.push(event.data); };
      recorder.start(1000); score();
    },
    async stop() {
      await new Promise(resolve => { state.recorder.onstop = resolve; state.recorder.stop(); });
      state.blob = new Blob(state.chunks, { type: state.recorder.mimeType });
      return { bytes: state.blob.size, mimeType: state.recorder.mimeType, seconds: (performance.now() - state.start) / 1000,
        frames: state.frameCount, timeline: state.timeline };
    },
    async chunk(offset, length) {
      const bytes = new Uint8Array(await state.blob.slice(offset, offset + length).arrayBuffer());
      let text = '';
      for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
      return btoa(text);
    },
    still() { return canvas.toDataURL('image/png').split(',')[1]; },
  };
}
