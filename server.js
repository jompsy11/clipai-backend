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
const UPLOAD_DIR = '/tmp/clipai-uploads';

if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ─── BINARY DOWNLOADER ───────────────────────────────────────────────────────
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
  // Start server immediately — download binaries in background
  callback();

  if (!fs.existsSync(YTDLP)) {
    console.log('⬇️ Downloading yt-dlp...');
    downloadFile('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux', YTDLP, (err) => {
      if (err) console.error('❌ yt-dlp failed:', err);
      else { fs.chmodSync(YTDLP, '755'); console.log('✅ yt-dlp ready!'); }
    });
  } else {
    console.log('✅ yt-dlp already exists');
  }

  if (!fs.existsSync(FFMPEG)) {
    console.log('⬇️ Downloading ffmpeg...');
    downloadFile('https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-linux-x64', FFMPEG, (err) => {
      if (err) console.error('❌ ffmpeg failed:', err);
      else { fs.chmodSync(FFMPEG, '755'); console.log('✅ ffmpeg ready!'); }
    });
  } else {
    console.log('✅ ffmpeg already exists');
  }
}

// ─── HELPER: HTTP request with Buffer body ───────────────────────────────────
function fetchWithBuffer(url, options) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const protocol = urlObj.protocol === 'https:' ? https : http;
    const reqOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    };
    if (options.body) reqOptions.headers['content-length'] = options.body.length;
    const req = protocol.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ─── CLIPAI DOWNLOADER: GET VIDEO INFO ───────────────────────────────────────
app.post('/api/info', (req, res) => {
  console.log('📥 /api/info:', req.body);
  const { url } = req.body;
  if (!url) return res.status(400).json({ message: 'No URL provided' });
  if (!fs.existsSync(YTDLP)) {
    return res.status(503).json({ message: 'Server is still starting up, please wait 30 seconds and try again.' });
  }
  exec(`"${YTDLP}" --no-playlist --no-warnings --print "%(title)s|||%(duration_string)s|||%(id)s" "${url}"`,
    { timeout: 60000 }, (err, stdout, stderr) => {
    console.log('yt-dlp stdout:', stdout);
    console.log('yt-dlp stderr:', stderr);
    console.log('yt-dlp err:', err ? err.message : 'none');
    if (err || !stdout.trim()) return res.status(500).json({ message: 'Could not fetch video info', error: stderr });
    const parts = stdout.trim().split('|||');
    const videoId = parts[2] || '';
    res.json({
      title: parts[0] || 'Video',
      duration: parts[1] || '',
      thumbnail: videoId ? `https://img.youtube.com/vi/${videoId}/mqdefault.jpg` : null,
      videoId
    });
  });
});

// ─── CLIPAI DOWNLOADER: DOWNLOAD FILE ────────────────────────────────────────
app.get('/api/download', (req, res) => {
  const { url, format, quality } = req.query;
  if (!url) return res.status(400).send('No URL');
  const filename = `clipai_${Date.now()}`;
  let outputPath, cmd, dlFilename, contentType;
  if (format === 'mp3') {
    const bitrate = quality ? quality.replace(' kbps', '') : '192';
    outputPath = path.join(DOWNLOAD_DIR, filename + '.mp3');
    dlFilename = 'audio.mp3'; contentType = 'audio/mpeg';
    cmd = `"${YTDLP}" --ffmpeg-location "${FFMPEG}" -x --audio-format mp3 --audio-quality ${bitrate}K -o "${outputPath}" "${url}"`;
  } else {
    const heights = { '480p': 480, '720p': 720, '1080p': 1080, '4K': 2160 };
    const h = heights[quality] || 720;
    outputPath = path.join(DOWNLOAD_DIR, filename + '.mp4');
    dlFilename = 'video.mp4'; contentType = 'video/mp4';
    cmd = `"${YTDLP}" --ffmpeg-location "${FFMPEG}" -f "bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${h}][ext=mp4]/best[height<=${h}]" --merge-output-format mp4 -o "${outputPath}" "${url}"`;
  }
  exec(cmd, { maxBuffer: 1024 * 1024 * 100, timeout: 600000 }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ message: 'Conversion failed', error: stderr });
    if (!fs.existsSync(outputPath)) return res.status(500).json({ message: 'File not created' });
    const stat = fs.statSync(outputPath);
    res.setHeader('Content-Disposition', `attachment; filename="${dlFilename}"`);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', stat.size);
    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on('close', () => { setTimeout(() => { try { fs.unlinkSync(outputPath); } catch(e) {} }, 5000); });
  });
});

// ─── CLIPAI APP: YOUTUBE UPLOAD ───────────────────────────────────────────────
app.post('/api/youtube-upload', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL provided' });
  console.log('📥 /api/youtube-upload:', url);

  if (!fs.existsSync(YTDLP)) {
    return res.status(503).json({ error: 'yt-dlp not ready yet, please wait 30 seconds and try again' });
  }

  const localFileId = `yt_${Date.now()}`;
  const outputPath = path.join(UPLOAD_DIR, localFileId + '.mp4');

  const cmd = `"${YTDLP}" --ffmpeg-location "${FFMPEG}" -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" --merge-output-format mp4 -o "${outputPath}" "${url}"`;
  console.log('Running:', cmd);

  exec(cmd, { maxBuffer: 1024 * 1024 * 200, timeout: 600000 }, async (err, stdout, stderr) => {
    if (err) {
      console.error('yt-dlp error:', stderr);
      return res.status(500).json({ error: 'YouTube download failed: ' + stderr.substring(0, 200) });
    }
    if (!fs.existsSync(outputPath)) return res.status(500).json({ error: 'Downloaded file not found' });

    const stat = fs.statSync(outputPath);
    console.log('✅ YouTube video downloaded, size:', stat.size);

    const ASSEMBLYAI_KEY = process.env.ASSEMBLYAI_API_KEY;
    if (!ASSEMBLYAI_KEY) {
      return res.json({ localFileId, uploadUrl: `https://${req.headers.host}/api/serve-upload/${localFileId}` });
    }

    try {
      const fileData = fs.readFileSync(outputPath);
      const uploadRes = await fetchWithBuffer('https://api.assemblyai.com/v2/upload', {
        method: 'POST',
        headers: { 'authorization': ASSEMBLYAI_KEY, 'content-type': 'application/octet-stream' },
        body: fileData
      });
      const uploadData = JSON.parse(uploadRes);
      console.log('✅ Uploaded to AssemblyAI:', uploadData.upload_url);
      res.json({ localFileId, uploadUrl: uploadData.upload_url });
    } catch (uploadErr) {
      console.error('AssemblyAI upload error:', uploadErr.message);
      res.json({ localFileId, uploadUrl: `https://${req.headers.host}/api/serve-upload/${localFileId}` });
    }
  });
});

// ─── CLIPAI APP: SERVE UPLOADED FILE ─────────────────────────────────────────
app.get('/api/serve-upload/:id', (req, res) => {
  const filePath = path.join(UPLOAD_DIR, req.params.id + '.mp4');
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  const stat = fs.statSync(filePath);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Length', stat.size);
  fs.createReadStream(filePath).pipe(res);
});

// ─── CLIPAI APP: LOCAL FILE UPLOAD ───────────────────────────────────────────
app.post('/api/upload-local', async (req, res) => {
  const filename = decodeURIComponent(req.headers['x-filename'] || 'upload.mp4');
  const localFileId = `upload_${Date.now()}`;
  const ext = path.extname(filename) || '.mp4';
  const outputPath = path.join(UPLOAD_DIR, localFileId + ext);
  console.log('📥 /api/upload-local receiving:', filename);

  const writeStream = fs.createWriteStream(outputPath);
  req.pipe(writeStream);

  writeStream.on('finish', async () => {
    const stat = fs.statSync(outputPath);
    console.log('✅ File saved locally, size:', stat.size);

    const ASSEMBLYAI_KEY = process.env.ASSEMBLYAI_API_KEY;
    if (!ASSEMBLYAI_KEY) {
      return res.json({ localFileId, uploadUrl: `https://${req.headers.host}/api/serve-upload-raw/${localFileId}${ext}` });
    }

    try {
      const fileData = fs.readFileSync(outputPath);
      const uploadRes = await fetchWithBuffer('https://api.assemblyai.com/v2/upload', {
        method: 'POST',
        headers: { 'authorization': ASSEMBLYAI_KEY, 'content-type': 'application/octet-stream' },
        body: fileData
      });
      const uploadData = JSON.parse(uploadRes);
      console.log('✅ Uploaded to AssemblyAI:', uploadData.upload_url);
      res.json({ localFileId, uploadUrl: uploadData.upload_url });
    } catch (err) {
      console.error('AssemblyAI upload error:', err.message);
      res.json({ localFileId, uploadUrl: `https://${req.headers.host}/api/serve-upload-raw/${localFileId}${ext}` });
    }
  });

  writeStream.on('error', (err) => {
    console.error('Write error:', err);
    res.status(500).json({ error: 'Failed to save file' });
  });
});

app.get('/api/serve-upload-raw/:filename', (req, res) => {
  const filePath = path.join(UPLOAD_DIR, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  const stat = fs.statSync(filePath);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Length', stat.size);
  fs.createReadStream(filePath).pipe(res);
});

// ─── CLIPAI APP: CUT CLIP ────────────────────────────────────────────────────
app.post('/api/cut-clip', (req, res) => {
  const { localFileId, startMs, endMs, clipTitle } = req.body;
  if (!localFileId) return res.status(400).json({ error: 'localFileId required' });

  if (!fs.existsSync(FFMPEG)) {
    return res.status(503).json({ error: 'ffmpeg not ready yet, please wait 30 seconds and try again' });
  }

  const files = fs.readdirSync(UPLOAD_DIR);
  const match = files.find(f => f.startsWith(localFileId));
  if (!match) return res.status(404).json({ error: 'Source file not found. Please re-upload.' });

  const inputPath = path.join(UPLOAD_DIR, match);
  const outputPath = path.join(DOWNLOAD_DIR, `clip_${Date.now()}.mp4`);

  const startSec = (startMs / 1000).toFixed(3);
  const durationSec = ((endMs - startMs) / 1000).toFixed(3);

  const cmd = `"${FFMPEG}" -y -ss ${startSec} -t ${durationSec} -i "${inputPath}" ` +
    `-vf "scale=480:854:force_original_aspect_ratio=decrease,pad=480:854:(ow-iw)/2:(oh-ih)/2:black" ` +
    `-c:v libx264 -preset ultrafast -crf 30 -tune fastdecode ` +
    `-c:a aac -b:a 64k -ac 1 ` +
    `-movflags +faststart -threads 1 ` +
    `"${outputPath}"`;

  console.log('Cutting clip:', clipTitle);

  exec(cmd, { maxBuffer: 1024 * 1024 * 500, timeout: 300000 }, (err, stdout, stderr) => {
    if (err || !fs.existsSync(outputPath)) {
      // Get the real error from stderr — skip ffmpeg header lines
      const lines = (stderr || '').split('\n').filter(l => l.trim());
      const errorLines = lines.filter(l =>
        l.includes('Error') || l.includes('error') ||
        l.includes('Invalid') || l.includes('No such') ||
        l.includes('failed') || l.includes('Cannot')
      );
      const realError = errorLines.length > 0
        ? errorLines.join(' | ').substring(0, 400)
        : (stderr || '').split('\n').slice(-5).join(' | ').substring(0, 400);
      console.error('FFmpeg real error:', realError);
      return res.status(500).json({ error: 'Cut failed: ' + realError });
    }

    const stat = fs.statSync(outputPath);
    console.log('✅ Clip cut, size:', stat.size);

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="clip.mp4"');
    res.setHeader('Content-Length', stat.size);

    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on('close', () => { setTimeout(() => { try { fs.unlinkSync(outputPath); } catch(e) {} }, 5000); });
  });
});

// ─── START ───────────────────────────────────────────────────────────────────
setup(() => {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log('✅ Clipai backend running on port ' + PORT));
});
