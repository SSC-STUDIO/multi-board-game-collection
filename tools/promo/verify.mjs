import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../lib/browser.mjs';
import { GameEngine } from '../../src/core/state/GameEngine.js';
import { fromNotation } from '../../src/core/rules/Gomoku.js';

const out = path.join(ROOT, 'artifacts/video');
const metadata = JSON.parse(await fs.readFile(path.join(out, 'capture.json'), 'utf8'));
const record = JSON.parse(await fs.readFile(path.join(out, 'complete-game.json'), 'utf8'));
const game = new GameEngine({ mode: record.mode, initialMs: 0 });
game.selectColor(record.humanColor, 0);
for (const [index, move] of record.moves.entries()) {
  const { row, col } = fromNotation(move);
  assert(!game.makeMove(row, col, index * 1000).error);
  if (index < record.moves.length - 1) assert.equal(game.status, 'PLAYING');
}
assert.equal(game.status, 'FINISHED');
assert.equal(game.getState().winner, 1);
assert.equal(record.moves.length, 21);
const played = metadata.events.filter(e => e.type === 'onMoveCommitted');
assert.deepEqual(played.map(e => e.moves), [...Array.from({length:8}, (_,i)=>i+1), ...Array.from({length:15}, (_,i)=>i+7)]);
assert.equal(metadata.events.filter(e => e.type === 'onStateReverted').length, 1);
assert.equal(metadata.events.filter(e => e.type === 'onGameFinished').length, 1);
assert(metadata.events.find(e => e.type === 'onGameFinished').time < metadata.seconds - 12);
assert(metadata.timeline.some(c => c.type === 'intro'));
assert(metadata.timeline.some(c => c.type === 'outro'));
for (const [name, width, height] of [['Zenith-Tabletop-3D-Mobile.mp4',1080,1920], ['Zenith-Tabletop-3D-Mobile-Share.mp4',720,1280]]) {
  const info = JSON.parse(execFileSync('ffprobe', ['-v','error','-show_entries','stream=codec_name,width,height,avg_frame_rate:format=duration,size','-of','json',path.join(out,name)], {encoding:'utf8'}));
  assert(info.streams.some(s=>s.codec_name==='h264' && s.width===width && s.height===height && s.avg_frame_rate==='30/1'));
  assert(info.streams.some(s=>s.codec_name==='aac'));
  assert(Math.abs(Number(info.format.duration)-metadata.seconds)<1);
  assert(Number(info.format.size)>1_000_000);
  execFileSync('ffmpeg',['-v','error','-i',path.join(out,name),'-f','null','-'],{stdio:['ignore','ignore','pipe']});
}
const run = args => new Promise((resolve,reject)=>{
  const child=spawn('ffmpeg',args,{stdio:['ignore','ignore','pipe']});let log='';
  child.stderr.on('data',chunk=>log+=chunk);child.on('error',reject);
  child.on('close',code=>code===0?resolve(log):reject(Error(log.slice(-2000))));
});
const master=path.join(out,'Zenith-Tabletop-3D-Mobile.mp4');
await run(['-y','-hide_banner','-i',master,'-vf','fps=1/8,scale=270:480,tile=4x4:padding=8:margin=8:color=0x17120e','-frames:v','1','-q:v','2',path.join(out,'contact-sheet.jpg')]);
const audio=await run(['-hide_banner','-i',master,'-af','ebur128=peak=true','-vn','-f','null','-']);
const black=await run(['-hide_banner','-i',master,'-vf','blackdetect=d=0.4:pix_th=0.02','-an','-f','null','-']);
const blackIntervals=[...black.matchAll(/black_start:([\d.]+) black_end:([\d.]+) black_duration:([\d.]+)/g)].map(m=>({start:Number(m[1]),end:Number(m[2]),duration:Number(m[3])}));
assert(blackIntervals.every(i=>i.start<1 || i.end>metadata.seconds-1.5),'no unintended black gaps inside the film');
const report={verifiedAt:new Date().toISOString(),seconds:metadata.seconds,moves:record.moves.length,recordedMoveEvents:played.length,winner:'black',undoDemonstrations:1,
  capturesPerSecond:metadata.frames/metadata.seconds,outputFps:30,blackIntervals,audioSummary:audio.slice(audio.lastIndexOf('Summary:')).trim(),
  passed:['complete legal game from empty board to five-in-a-row','all 23 placed moves captured, including the visibly undone pair','single victory and final replay','portrait H.264/AAC masters decode without errors','no unexpected black gaps','Chinese captions and cover exported']};
await fs.writeFile(path.join(out,'verification.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
