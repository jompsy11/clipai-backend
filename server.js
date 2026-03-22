const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'clipaidownloader.html')));

const YTDLP = path.join(__dirname, 'yt-dlp');
const DOWNLOAD_DIR = '/tmp/clipai';

// Make sure download dir exists
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

function setupYtDlp(callback) {
  if (fs.existsSync(YTDLP)) {
    console.log('✅ yt-dlp already exists');
    exec('ffmpeg -version', (err, stdout) => {
      console.log(err ? '❌ FFmpeg NOT found' : '✅ FFmpeg found');
    });
    return callback();
  }
  console.log('⬇️ Downloading yt-dlp...');
  const file = fs.createWriteStream(YTDLP);
  https.get('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp', (res) => {
    if (res.statusCode === 302 || res.statusCode === 301) {
      https.get(res.headers.location, (res2) => {
        res2.pipe(file);
        file.on('finish', () => { file.close(); fs.chmodSync(YTDLP, '755'); console.log('✅ yt-dlp downloaded!'); callback(); });
      });
    } else {
      res.pipe(file);
      file.on('finish', () => { file.close(); fs.chmodSync(YTDLP, '755'); console.log('✅ yt-dlp downloaded!'); callback(); });
    }
  }).on('error', (err) => { console.error('❌ Failed:', err); callback(); });
}

// Get video info
app.post('/api/info', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ message: 'No URL provided' });
  exec(`"${YTDLP}" --print "%(title)s|||%(duration_string)s|||%(id)s" "${url}"`, (err, stdout) => {
    if (err) return res.status(500).json({ message: 'Could not fetch video info' });
    const parts = (stdout || '').trim().split('|||');
    const title = parts[0] || 'Video';
    const duration = parts[1] || '';
    const videoId = parts[2] || '';
    const thumbnail = videoId ? `https://img.youtube.com/vi/${videoId}/mqdefault.jpg` : null;
    res.json({ title, duration, thumbnail, videoId });
  });
});

// Download - save to /tmp then send
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
    cmd = `"${YTDLP}" -x --audio-format mp3 --audio-quality ${bitrate}K -o "${outputPath}" "${url}"`;
  } else {
    const heights = { '480p': 480, '720p': 720, '1080p': 1080, '4K': 2160 };
    const h = heights[quality] || 720;
    outputPath = path.join(DOWNLOAD_DIR, filename + '.mp4');
    dlFilename = 'video.mp4';
    contentType = 'video/mp4';
    cmd = `"${YTDLP}" -f "bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${h}][ext=mp4]/best[height<=${h}]" --merge-output-format mp4 -o "${outputPath}" "${url}"`;
  }

  console.log('Starting download:', cmd);

  exec(cmd, { maxBuffer: 1024 * 1024 * 100 }, (err, stdout, stderr) => {
    if (err) {
      console.error('Error:', stderr);
      return res.status(500).json({ message: 'Conversion failed' });
    }

    if (!fs.existsSync(outputPath)) {
      return res.status(500).json({ message: 'File not created', error: stderr, cmd: cmd });
    }

    const stat = fs.statSync(outputPath);
    console.log('File size:', stat.size);

    res.setHeader('Content-Disposition', `attachment; filename="${dlFilename}"`);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', stat.size);

    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);

    stream.on('close', () => {
      setTimeout(() => {
        try { fs.unlinkSync(outputPath); } catch(e) {}
      }, 5000);
    });
  });
});

setupYtDlp(() => {
  app.listen(3000, () => console.log('✅ Clipai running at http://localhost:3000'));
});
