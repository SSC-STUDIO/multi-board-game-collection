import { execFileSync, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../lib/browser.mjs';

const out = path.join(ROOT, 'artifacts/video');
const meta = JSON.parse(await fs.readFile(path.join(out, 'capture.json'), 'utf8'));
const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr.slice(-6000))));
});
const name = 'Zenith-Tabletop-3D-Mobile';
const fade = Math.max(0, meta.seconds - 1.1).toFixed(3);
console.log('Encoding the 1080 × 1920 H.264 / AAC phone master...');
await run('ffmpeg', ['-y', '-hide_banner', '-i', path.join(out, meta.sourceFile ?? 'zenith-mobile-master.webm'),
  '-vf', `fps=30,format=yuv420p,fade=t=in:st=0:d=0.65,fade=t=out:st=${fade}:d=0.9`,
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-profile:v', 'high', '-level:v', '4.2',
  '-af', `loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=in:st=0:d=0.65,afade=t=out:st=${fade}:d=0.9`,
  '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart',
  '-metadata', 'title=Zenith Tabletop 3D | 完整对局', '-metadata', 'artist=SSC-STUDIO', path.join(out, `${name}.mp4`)]);
console.log('Creating a smaller 720 × 1280 copy for sharing...');
await run('ffmpeg', ['-y', '-hide_banner', '-i', path.join(out, `${name}.mp4`), '-vf', 'scale=720:1280:flags=lanczos',
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
  path.join(out, `${name}-Share.mp4`)]);
await run('ffmpeg', ['-y', '-hide_banner', '-i', path.join(out, 'cover.png'), '-frames:v', '1', '-q:v', '2', path.join(out, `${name}-Cover.jpg`)]);
const timestamp = seconds => {
  const ms = Math.max(0, Math.round(seconds * 1000));
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
};
const subtitles = meta.timeline.map((cue, i) => `${i + 1}\n${timestamp(cue.at)} --> ${timestamp(meta.timeline[i + 1]?.at ?? meta.seconds)}\n${cue.type === 'intro' ? '巅峰棋道 · Zenith Tabletop 3D' : cue.type === 'outro' ? '下一局，轮到你。' : cue.title}\n${cue.caption}\n`).join('\n');
await fs.writeFile(path.join(out, `${name}.srt`), subtitles);
for (const file of [`${name}.mp4`, `${name}-Share.mp4`]) {
  const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries',
    'stream=codec_name,width,height,avg_frame_rate,nb_read_frames,sample_rate:format=duration,size', '-of', 'json', path.join(out, file)], { encoding: 'utf8' }));
  console.log(file, JSON.stringify(info));
  await fs.writeFile(path.join(out, `${file}.probe.json`), JSON.stringify(info, null, 2));
}
console.log('Video, sharing copy, cover, subtitles and complete game record are ready.');
