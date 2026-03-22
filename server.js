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

// Use local yt-dlp on Windows, downloaded binary on Linux (Railway)
const IS_WINDOWS = process.platform === 'win32';
const YTDLP_WIN = 'C:\\Users\\USER\\AppData\\Local\\Programs\\Python\\Python313\\Scripts\\yt-dlp.exe';
const YTDLP_LINUX = path.join(__dirname, 'yt-dlp');
const FFMPEG_LINUX = path.join(__dirname, 'ffmpeg');
let YTDLP = IS_WINDOWS ? YTDLP_WIN : YTDLP_LINUX;
let FFMPEG = IS_WINDOWS ? 'ffmpeg' : FFMPEG_LINUX;

const DOWNLOAD_DIR = IS_WINDOWS ? path.join(__dirname, 'downloads') : '/tmp/clipai';
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

// Download a binary file (for Linux/Railway setup)
function downloadBinary(url, dest, callback) {
  const file = fs.createWriteStream(dest);
  const protocol = url.startsWith('https') ? https : http;
  protocol.get(url, (res) => {
    if (res.statusCode === 301 || res.statusCode === 302) {
      file.close();
      try { fs.unlinkSync(dest); } catch(e) {}
      return downloadBinary(res.headers.location, dest, callback);
    }
    res.pipe(file);
    file.on('finish', () => { file.close(); callback(null); });
  }).on('error', (err) => {
    try { fs.unlinkSync(dest); } catch(e) {}
    callback(err);
  });
}

// Setup binaries on Linux/Railway
function setup(callback) {
  if (IS_WINDOWS) return callback();

  let pending = 2;
  const done = () => { if (--pending === 0) callback(); };

  // yt-dlp
  if (fs.existsSync(YTDLP_LINUX)) fs.unlinkSync(YTDLP_LINUX);
  console.log('⬇️ Downloading yt-dlp...');
  downloadBinary('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux', YTDLP_LINUX, (err) => {
    if (err) console.error('❌ yt-dlp failed:', err);
    else { fs.chmodSync(YTDLP_LINUX, '755'); console.log('✅ yt-dlp ready!'); }
    done();
  });

  // ffmpeg
  if (fs.existsSync(FFMPEG_LINUX)) fs.unlinkSync(FFMPEG_LINUX);
  console.log('⬇️ Downloading ffmpeg...');
  downloadBinary('https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-linux-x64', FFMPEG_LINUX, (err) => {
    if (err) console.error('❌ ffmpeg failed:', err);
    else { fs.chmodSync(FFMPEG_LINUX, '755'); console.log('✅ ffmpeg ready!'); }
    done();
  });
}

// ── Original convert endpoint ──
app.post('/api/convert', (req, res) => {
  const { url, format, quality } = req.body;
  if (!url) return res.status(400).json({ message: 'No URL provided' });

  const filename = `download_${Date.now()}`;
  let outputPath, cmd;

  if (format === 'mp3') {
    const bitrate = quality ? quality.replace(' kbps', '') : '192';
    outputPath = path.join(DOWNLOAD_DIR, filename + '.mp3');
    cmd = IS_WINDOWS
      ? `"${YTDLP}" -x --audio-format mp3 --audio-quality ${bitrate}K -o "${outputPath}" "${url}"`
      : `"${YTDLP}" --ffmpeg-location "${FFMPEG}" -x --audio-format mp3 --audio-quality ${bitrate}K -o "${outputPath}" "${url}"`;
  } else {
    const heights = { '480p': 480, '720p': 720, '1080p': 1080, '4K': 2160 };
    const h = heights[quality] || 720;
    outputPath = path.join(DOWNLOAD_DIR, filename + '.mp4');
    cmd = IS_WINDOWS
      ? `"${YTDLP}" -f "bestvideo[height<=${h}]+bestaudio/best[height<=${h}]" --merge-output-format mp4 -o "${outputPath}" "${url}"`
      : `"${YTDLP}" --ffmpeg-location "${FFMPEG}" -f "bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${h}][ext=mp4]/best[height<=${h}]" --merge-output-format mp4 -o "${outputPath}" "${url}"`;
  }

  exec(`"${YTDLP}" --print "%(title)s|||%(thumbnail)s|||%(duration_string)s" "${url}"`, (err, stdout) => {
    const parts = (stdout || '').trim().split('|||');
    const title = parts[0] || 'Video';
    const thumbnail = parts[1] || null;
    const duration = parts[2] || '';

    exec(cmd, { maxBuffer: 1024 * 1024 * 100, timeout: 600000 }, (err2, stdout2, stderr2) => {
      if (err2) {
        console.error('Conversion error:', stderr2);
        return res.status(500).json({ message: 'Conversion failed: ' + stderr2 });
      }
      const downloadUrl = `/downloads/${path.basename(outputPath)}`;
      res.json({ title, thumbnail, duration, downloadUrl });
      setTimeout(() => { try { fs.unlinkSync(outputPath); } catch(e) {} }, 30 * 60 * 1000);
    });
  });
});

app.use('/downloads', express.static(DOWNLOAD_DIR));

// ── NEW: YouTube → AssemblyAI upload (for ClipAI main app) ──
app.post('/api/youtube-upload', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  const ASSEMBLYAI_KEY = process.env.ASSEMBLYAI_API_KEY;
  if (!ASSEMBLYAI_KEY) return res.status(500).json({ error: 'ASSEMBLYAI_API_KEY not set in Railway environment variables' });

  const ts = Date.now();
  const outputPath = path.join(DOWNLOAD_DIR, 'clipai_yt_' + ts + '.m4a');
  console.log('[ClipAI] Downloading YouTube audio:', url.substring(0, 60));

  const cmd = IS_WINDOWS
    ? `"${YTDLP}" -f "bestaudio[ext=m4a]/bestaudio/best" --no-playlist --no-warnings -o "${outputPath}" "${url}"`
    : `"${YTDLP}" -f "bestaudio[ext=m4a]/bestaudio/best" --no-playlist --no-warnings -o "${outputPath}" "${url}"`;

  exec(cmd, { timeout: 300000, maxBuffer: 1024 * 1024 * 10 }, async (err, stdout, stderr) => {
    if (err) {
      console.error('[ClipAI] yt-dlp error:', stderr);
      return res.status(500).json({ error: 'YouTube download failed: ' + (stderr || err.message).slice(0, 200) });
    }

    // Find actual downloaded file (yt-dlp may change extension)
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
        headers: {
          'authorization': ASSEMBLYAI_KEY,
          'content-type': 'application/octet-stream'
        },
        body: buffer
      });

      const uploadData = await uploadRes.json();
      if (!uploadRes.ok) throw new Error(uploadData.error || 'AssemblyAI upload failed');

      const localFileId = path.basename(actualFile);
      console.log('[ClipAI] Ready, localFileId:', localFileId);

      res.json({
        uploadUrl: uploadData.upload_url,
        localFileId,
        source: 'youtube'
      });
    } catch (fetchErr) {
      console.error('[ClipAI] Upload error:', fetchErr.message);
      res.status(500).json({ error: fetchErr.message });
    } finally {
      try { fs.unlinkSync(actualFile); } catch(e) {}
    }
  });
});

// ── NEW: Video cutting endpoint (for ClipAI main app) ──
app.post('/api/cut-clip', (req, res) => {
  const { localFileId, startMs, endMs, clipTitle, captionLines, words } = req.body;
  if (!localFileId) return res.status(400).json({ error: 'localFileId is required' });
  if (startMs === undefined || endMs === undefined) return res.status(400).json({ error: 'startMs and endMs required' });

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
    return String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0') + ',' + String(ms).padStart(3,'0');
  }

  const cleanup = () => {
    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch(e) {}
    try { if (fs.existsSync(srtPath)) fs.unlinkSync(srtPath); } catch(e) {}
  };

  // Build SRT captions
  let srtCreated = false;
  const wordList = (words || []).filter(w => w.start >= startMs && w.start <= endMs);

  if (wordList.length > 0) {
    const chunks = [];
    for (let i = 0; i < wordList.length; i += 3) {
      const group = wordList.slice(i, i + 3);
      const text = group.map(w => w.text).join(' ');
      const chunkStart = Math.max(0, (group[0].start - startMs) / 1000);
      const chunkEnd = (group[group.length - 1].end - startMs) / 1000 + 0.1;
      chunks.push({ text, start: chunkStart, end: chunkEnd });
    }
    const srtContent = chunks.map((c, i) =>
      (i + 1) + '\n' + toSRTTime(c.start) + ' --> ' + toSRTTime(c.end) + '\n' + c.text + '\n'
    ).join('\n');
    fs.writeFileSync(srtPath, srtContent);
    srtCreated = true;
  } else if ((captionLines || []).length > 0) {
    const totalDur = (endMs - startMs) / 1000;
    const segDur = totalDur / captionLines.length;
    const srtContent = captionLines.map((line, i) => {
      return (i + 1) + '\n' + toSRTTime(i * segDur) + ' --> ' + toSRTTime((i + 1) * segDur) + '\n' + line + '\n';
    }).join('\n');
    fs.writeFileSync(srtPath, srtContent);
    srtCreated = true;
  }

  const startSec = (startMs / 1000).toFixed(3);
  const endSec = (endMs / 1000).toFixed(3);

  let vfFilter = 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black';
  if (srtCreated) {
    const srtEscaped = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:');
    vfFilter += ',subtitles=' + srtEscaped + ':force_style=\'FontName=Arial,FontSize=16,PrimaryColour=&H00ffffff,OutlineColour=&H00000000,Outline=2,Bold=1,Alignment=2,MarginV=50\'';
  }

  const ffmpegBin = IS_WINDOWS ? 'ffmpeg' : FFMPEG;
  const ffmpegCmd = `"${ffmpegBin}" -y -ss ${startSec} -to ${endSec} -i "${inputPath}" -vf "${vfFilter}" -c:v libx264 -preset ultrafast -crf 28 -c:a aac -b:a 96k -movflags +faststart -threads 1 "${outputPath}"`;

  console.log('[ClipAI] Cutting clip:', safeFileId, 'from', startSec, 'to', endSec);

  exec(ffmpegCmd, { timeout: 600000, maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
    if (err || !fs.existsSync(outputPath)) {
      cleanup();
      return res.status(500).json({ error: 'FFmpeg failed: ' + (stderr || err.message).slice(0, 300) });
    }

    const outSize = fs.statSync(outputPath).size;
    console.log('[ClipAI] Clip ready:', (outSize / 1024 / 1024).toFixed(1), 'MB');

    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Disposition': 'attachment; filename="' + safeTitle + '_9x16.mp4"',
      'Content-Length': outSize,
      'Cache-Control': 'no-cache'
    });

    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on('end', cleanup);
    stream.on('error', cleanup);
  });
});

// ── NEW: Local file upload endpoint (for ClipAI main app) ──
app.post('/api/upload-local', async (req, res) => {
  const ASSEMBLYAI_KEY = process.env.ASSEMBLYAI_API_KEY;
  if (!ASSEMBLYAI_KEY) return res.status(500).json({ error: 'ASSEMBLYAI_API_KEY not set' });

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
    const buffer = Buffer.concat(chunks);
    if (buffer.length < 1000) return res.status(400).json({ error: 'File too small or empty' });

    fs.writeFileSync(localPath, buffer);
    console.log('[ClipAI] Saved locally:', localFilename, (buffer.length / 1024 / 1024).toFixed(1), 'MB');

    try {
      const uploadRes = await fetch('https://api.assemblyai.com/v2/upload', {
        method: 'POST',
        headers: { 'authorization': ASSEMBLYAI_KEY, 'content-type': 'application/octet-stream' },
        body: buffer
      });
      const uploadData = await uploadRes.json();
      if (!uploadRes.ok) throw new Error(uploadData.error || 'AssemblyAI upload failed');

      res.json({ uploadUrl: uploadData.upload_url, localFileId: localFilename, filename: originalName });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  req.on('error', err => res.status(500).json({ error: err.message }));
});

setup(() => {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log('✅ Clipai backend running at http://localhost:' + PORT));
});
