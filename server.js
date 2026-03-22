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
      fs.unlinkSync(dest);
      downloadFile(res.headers.location, dest, callback);
    } else {
      res.pipe(file);
      file.on('finish', () => { file.close(); callback(null); });
    }
  }).on('error', (err) => { fs.unlinkSync(dest); callback(err); });
}

function setup(callback) {
  let pending = 0;

  // Always re-download yt-dlp to ensure correct binary
  if (fs.existsSync(YTDLP)) fs.unlinkSync(YTDLP);
  if (fs.existsSync(FFMPEG)) fs.unlinkSync(FFMPEG);

  // Setup yt-dlp
  if (!fs.existsSync(YTDLP)) {
    pending++;
    console.log('⬇️ Downloading yt-dlp...');
    downloadFile('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux', YTDLP, (err) => {
      if (err) console.error('❌ yt-dlp failed:', err);
      else { fs.chmodSync(YTDLP, '755'); console.log('✅ yt-dlp ready!'); }
      if (--pending === 0) callback();
    });
  } else {
    console.log('✅ yt-dlp already exists');
  }

  // Setup ffmpeg
  if (!fs.existsSync(FFMPEG)) {
    pending++;
    console.log('⬇️ Downloading ffmpeg...');
    // Static ffmpeg binary for Linux x64
    const ffmpegUrl = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-linux-x64';
    downloadFile(ffmpegUrl, FFMPEG, (err) => {
      if (err) console.error('❌ ffmpeg failed:', err);
      else { fs.chmodSync(FFMPEG, '755'); console.log('✅ ffmpeg ready!'); }
      if (--pending === 0) callback();
    });
  } else {
    console.log('✅ ffmpeg already exists');
  }

  if (pending === 0) callback();
}

// Get video info
app.post('/api/info', (req, res) => {
  console.log('📥 /api/info called with:', req.body);
  const { url } = req.body;
  if (!url) return res.status(400).json({ message: 'No URL provided' });
  const infoCmd = `"${YTDLP}" --no-playlist --print "%(title)s|||%(duration_string)s|||%(id)s" "${url}"`;
  console.log('Running:', infoCmd);
  exec(infoCmd, { timeout: 60000 }, (err, stdout, stderr) => {
    console.log('stdout:', stdout);
    console.log('stderr:', stderr);
    console.log('err:', err);
    if (err || !stdout.trim()) return res.status(500).json({ message: 'Could not fetch video info', error: stderr });
    const parts = (stdout || '').trim().split('|||');
    const title = parts[0] || 'Video';
    const duration = parts[1] || '';
    const videoId = parts[2] || '';
    const thumbnail = videoId ? `https://img.youtube.com/vi/${videoId}/mqdefault.jpg` : null;
    res.json({ title, duration, thumbnail, videoId });
  });
});

// Download
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

setup(() => {
  app.listen(3000, () => console.log('✅ Clipai running at http://localhost:3000'));
});
