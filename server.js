const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'clipaidownloader.html')));

const YTDLP = path.join(__dirname, 'yt-dlp');
const FFMPEG = path.join(__dirname, 'ffmpeg');
const DOWNLOAD_DIR = '/tmp/clipai';

if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

function downloadFile(url, dest, callback) {
  const file = fs.createWriteStream(dest);
  const protocol = url.startsWith('https') ? https : http;
  protocol.get(url, (res) => {
    if (res.statusCode === 302 || res.statusCode === 301) {
      file.close();
      try { fs.unlinkSync(dest); } catch(e) {}
      downloadFile(res.headers.location, dest, callback);
    } else {
      res.pipe(file);
      file.on('finish', () => { file.close(); callback(null); });
    }
  }).on('error', (err) => {
    try { fs.unlinkSync(dest); } catch(e) {}
    callback(err);
  });
}

function setup(callback) {
  // Start server immediately — don't block on binary downloads
  callback();

  // Download yt-dlp in background if not present
  if (!fs.existsSync(YTDLP)) {
    console.log('⬇️ Downloading yt-dlp...');
    downloadFile('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux', YTDLP, (err) => {
      if (err) console.error('❌ yt-dlp failed:', err.message);
      else { fs.chmodSync(YTDLP, '755'); console.log('✅ yt-dlp ready!'); }
    });
  } else {
    console.log('✅ yt-dlp already exists');
  }

  // Download ffmpeg in background if not present
  if (!fs.existsSync(FFMPEG)) {
    console.log('⬇️ Downloading ffmpeg...');
    downloadFile('https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-linux-x64', FFMPEG, (err) => {
      if (err) console.error('❌ ffmpeg failed:', err.message);
      else { fs.chmodSync(FFMPEG, '755'); console.log('✅ ffmpeg ready!'); }
    });
  } else {
    console.log('✅ ffmpeg already exists');
  }
}

// ── Original: Get video info ──
app.post('/api/info', (req, res) => {
  console.log('📥 /api/info called with:', req.body);
  const { url } = req.body;
  if (!url) return res.status(400).json({ message: 'No URL provided' });

  const infoCmd = `"${YTDLP}" --no-playlist --print "%(title)s|||%(duration_string)s|||%(id)s" "${url}"`;
  console.log('Running:', infoCmd);
  exec(infoCmd, { timeout: 60000 }, (err, stdout, stderr) => {
    console.log('stdout:', stdout);
    console.log('stderr:', stderr);
    if (err || !stdout.trim()) return res.status(500).json({ message: 'Could not fetch video info', error: stderr });
    const parts = stdout.trim().split('|||');
    const title = parts[0] || 'Video';
    const duration = parts[1] || '';
    const videoId = parts[2] || '';
    const thumbnail = videoId ? `https://img.youtube.com/vi/${videoId}/mqdefault.jpg` : null;
    res.json({ title, duration, thumbnail, videoId });
  });
});

// ── Original: Download video/audio ──
app.get('/api/download', (req, res) => {
  const { url, format, quality } = req.query;
  if (!url) return res.status(400).send('No URL');

  const filename = `clipai_${Date.now()}`;
  let outputPath, cmd, dlFilename, contentType;

  if (format === 'mp3') {
    const bitrate = quality ? quality.replace(' kbps', '') : '192';
    outputPath = path.join(DOWNLOAD_DIR, filename + '.mp3');
    dlFilename = 'audio.mp3';
    contentType = 'audio/mpeg';
    cmd = `"${YTDLP}" --ffmpeg-location "${FFMPEG}" -x --audio-format mp3 --audio-quality ${bitrate}K -o "${outputPath}" "${url}"`;
  } else {
    const heights = { '480p': 480, '720p': 720, '1080p': 1080, '4K': 2160 };
    const h = heights[quality] || 720;
    outputPath = path.join(DOWNLOAD_DIR, filename + '.mp4');
    dlFilename = 'video.mp4';
    contentType = 'video/mp4';
    cmd = `"${YTDLP}" --ffmpeg-location "${FFMPEG}" -f "bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${h}][ext=mp4]/best[height<=${h}]" --merge-output-format mp4 -o "${outputPath}" "${url}"`;
  }

  console.log('Running:', cmd);
  exec(cmd, { maxBuffer: 1024 * 1024 * 100, timeout: 600000 }, (err, stdout, stderr) => {
    if (err) {
      console.error('Error:', stderr);
      return res.status(500).json({ message: 'Conversion failed', error: stderr });
    }
    if (!fs.existsSync(outputPath)) {
      return res.status(500).json({ message: 'File not created', error: stderr });
    }

    const stat = fs.statSync(outputPath);
    console.log('✅ File ready, size:', stat.size);

    res.setHeader('Content-Disposition', `attachment; filename="${dlFilename}"`);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', stat.size);

    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on('close', () => {
      setTimeout(() => { try { fs.unlinkSync(outputPath); } catch(e) {} }, 5000);
    });
  });
});

// ── NEW: File upload for ClipAI (saves locally + uploads to AssemblyAI) ──
app.post('/api/upload-local', async (req, res) => {
  const ASSEMBLYAI_KEY = process.env.ASSEMBLYAI_API_KEY;
  if (!ASSEMBLYAI_KEY) return res.status(500).json({ error: 'ASSEMBLYAI_API_KEY not set in Railway variables' });

  const originalName = req.headers['x-filename']
    ? decodeURIComponent(req.headers['x-filename'])
    : 'upload.mp4';
  const ext = path.extname(originalName) || '.mp4';
  const localFilename = 'clipai_' + Date.now() + ext;
  const localPath = path.join(DOWNLOAD_DIR, localFilename);

  console.log('[ClipAI] Receiving upload:', originalName);

  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', async () => {
    try {
      const buffer = Buffer.concat(chunks);
      if (buffer.length < 1000) return res.status(400).json({ error: 'File too small or empty' });

      fs.writeFileSync(localPath, buffer);
      console.log('[ClipAI] Saved locally:', localFilename, (buffer.length / 1024 / 1024).toFixed(1), 'MB');

      const uploadRes = await fetch('https://api.assemblyai.com/v2/upload', {
        method: 'POST',
        headers: { 'authorization': ASSEMBLYAI_KEY, 'content-type': 'application/octet-stream' },
        body: buffer
      });
      const uploadData = await uploadRes.json();
      if (!uploadRes.ok) throw new Error(uploadData.error || 'AssemblyAI upload failed');

      res.json({ uploadUrl: uploadData.upload_url, localFileId: localFilename, filename: originalName });
    } catch (err) {
      console.error('[ClipAI] upload-local error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
  req.on('error', err => res.status(500).json({ error: err.message }));
});

// ── NEW: YouTube download for ClipAI ──
app.post('/api/youtube-upload', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  const ASSEMBLYAI_KEY = process.env.ASSEMBLYAI_API_KEY;
  if (!ASSEMBLYAI_KEY) return res.status(500).json({ error: 'ASSEMBLYAI_API_KEY not set in Railway variables' });

  if (!fs.existsSync(YTDLP)) {
    return res.status(503).json({ error: 'yt-dlp is still downloading, please wait 30 seconds and try again' });
  }

  const ts = Date.now();
  const outputPath = path.join(DOWNLOAD_DIR, 'clipai_yt_' + ts + '.m4a');
  console.log('[ClipAI] Downloading YouTube audio:', url.substring(0, 60));

  const cmd = `"${YTDLP}" -f "bestaudio[ext=m4a]/bestaudio/best" --no-playlist --no-warnings -o "${outputPath}" "${url}"`;

  exec(cmd, { timeout: 300000, maxBuffer: 1024 * 1024 * 10 }, async (err, stdout, stderr) => {
    if (err) {
      console.error('[ClipAI] yt-dlp error:', stderr);
      return res.status(500).json({ error: 'YouTube download failed: ' + (stderr || err.message).slice(0, 200) });
    }

    // Find actual file (yt-dlp may change extension)
    let actualFile = outputPath;
    if (!fs.existsSync(actualFile)) {
      const files = fs.readdirSync(DOWNLOAD_DIR)
        .filter(f => f.startsWith('clipai_yt_' + ts))
        .map(f => path.join(DOWNLOAD_DIR, f));
      if (files.length === 0) return res.status(500).json({ error: 'Downloaded file not found' });
      actualFile = files[0];
    }

    console.log('[ClipAI] Downloaded:', (fs.statSync(actualFile).size / 1024 / 1024).toFixed(1), 'MB');

    try {
      const buffer = fs.readFileSync(actualFile);
      const uploadRes = await fetch('https://api.assemblyai.com/v2/upload', {
        method: 'POST',
        headers: { 'authorization': ASSEMBLYAI_KEY, 'content-type': 'application/octet-stream' },
        body: buffer
      });
      const uploadData = await uploadRes.json();
      if (!uploadRes.ok) throw new Error(uploadData.error || 'AssemblyAI upload failed');

      res.json({ uploadUrl: uploadData.upload_url, localFileId: path.basename(actualFile), source: 'youtube' });
    } catch (fetchErr) {
      res.status(500).json({ error: fetchErr.message });
    } finally {
      try { fs.unlinkSync(actualFile); } catch(e) {}
    }
  });
});

// ── NEW: Video cutting for ClipAI ──
app.post('/api/cut-clip', (req, res) => {
  const { localFileId, startMs, endMs, clipTitle, captionLines, words } = req.body;
  if (!localFileId) return res.status(400).json({ error: 'localFileId is required' });
  if (startMs === undefined || endMs === undefined) return res.status(400).json({ error: 'startMs and endMs required' });

  if (!fs.existsSync(FFMPEG)) {
    return res.status(503).json({ error: 'ffmpeg is still downloading, please wait 30 seconds and try again' });
  }

  const safeFileId = path.basename(localFileId);
  const inputPath = path.join(DOWNLOAD_DIR, safeFileId);
  if (!fs.existsSync(inputPath)) {
    return res.status(404).json({ error: 'Source video not found. Please re-upload your video.' });
  }

  const ts = Date.now();
  const safeTitle = (clipTitle || 'clip').replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
  const outputPath = path.join(DOWNLOAD_DIR, 'clipai_out_' + ts + '.mp4');
  const srtPath = path.join(DOWNLOAD_DIR, 'clipai_subs_' + ts + '.srt');

  function toSRTTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.round((seconds % 1) * 1000);
    return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0')+','+String(ms).padStart(3,'0');
  }

  const cleanup = () => {
    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch(e) {}
    try { if (fs.existsSync(srtPath)) fs.unlinkSync(srtPath); } catch(e) {}
  };

  // Build SRT
  let srtCreated = false;
  const wordList = (words || []).filter(w => w.start >= startMs && w.start <= endMs);
  if (wordList.length > 0) {
    const chunks = [];
    for (let i = 0; i < wordList.length; i += 3) {
      const group = wordList.slice(i, i + 3);
      chunks.push({
        text: group.map(w => w.text).join(' '),
        start: Math.max(0, (group[0].start - startMs) / 1000),
        end: (group[group.length-1].end - startMs) / 1000 + 0.1
      });
    }
    fs.writeFileSync(srtPath, chunks.map((c,i) =>
      (i+1)+'\n'+toSRTTime(c.start)+' --> '+toSRTTime(c.end)+'\n'+c.text+'\n'
    ).join('\n'));
    srtCreated = true;
  } else if ((captionLines||[]).length > 0) {
    const totalDur = (endMs - startMs) / 1000;
    const segDur = totalDur / captionLines.length;
    fs.writeFileSync(srtPath, captionLines.map((line,i) =>
      (i+1)+'\n'+toSRTTime(i*segDur)+' --> '+toSRTTime((i+1)*segDur)+'\n'+line+'\n'
    ).join('\n'));
    srtCreated = true;
  }

  const startSec = (startMs/1000).toFixed(3);
  const endSec = (endMs/1000).toFixed(3);
  let vfFilter = 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black';
  if (srtCreated) {
    const srtEscaped = srtPath.replace(/\\/g,'/').replace(/:/g,'\\:');
    vfFilter += ',subtitles='+srtEscaped+':force_style=\'FontName=Arial,FontSize=16,PrimaryColour=&H00ffffff,OutlineColour=&H00000000,Outline=2,Bold=1,Alignment=2,MarginV=50\'';
  }

  const cmd = `"${FFMPEG}" -y -ss ${startSec} -to ${endSec} -i "${inputPath}" -vf "${vfFilter}" -c:v libx264 -preset ultrafast -crf 28 -c:a aac -b:a 96k -movflags +faststart -threads 1 "${outputPath}"`;
  console.log('[ClipAI] Cutting clip:', safeFileId, startSec, '->', endSec);

  exec(cmd, { timeout: 600000, maxBuffer: 1024*1024*10 }, (err, stdout, stderr) => {
    if (err || !fs.existsSync(outputPath)) {
      cleanup();
      return res.status(500).json({ error: 'FFmpeg failed: ' + (stderr||err.message).slice(0,300) });
    }
    const outSize = fs.statSync(outputPath).size;
    console.log('[ClipAI] Clip ready:', (outSize/1024/1024).toFixed(1), 'MB');

    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Disposition': 'attachment; filename="'+safeTitle+'_9x16.mp4"',
      'Content-Length': outSize,
      'Cache-Control': 'no-cache'
    });
    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on('end', cleanup);
    stream.on('error', cleanup);
  });
});

setup(() => {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log('✅ Clipai backend running at http://localhost:' + PORT));
});
