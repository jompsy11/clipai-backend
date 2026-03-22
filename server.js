const express = require('express');
const cors = require('cors');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'clipaidownloader.html')));

const YTDLP = path.join(__dirname, 'yt-dlp');

function setupYtDlp(callback) {
  if (fs.existsSync(YTDLP)) {
    console.log('✅ yt-dlp already exists');
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

// Get video info only
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

// Stream download directly to user
app.get('/api/download', (req, res) => {
  const { url, format, quality } = req.query;
  if (!url) return res.status(400).send('No URL');

  let ytdlpArgs, filename, contentType;

  if (format === 'mp3') {
    const bitrate = quality ? quality.replace(' kbps', '') : '192';
    filename = 'audio.mp3';
    contentType = 'audio/mpeg';
    ytdlpArgs = [
      '-x', '--audio-format', 'mp3',
      '--audio-quality', `${bitrate}K`,
      '-o', '-',
      url
    ];
  } else {
    const heights = { '480p': 480, '720p': 720, '1080p': 1080, '4K': 2160 };
    const h = heights[quality] || 720;
    filename = 'video.mp4';
    contentType = 'video/mp4';
    ytdlpArgs = [
      '-f', `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${h}][ext=mp4]/best[height<=${h}]`,
      '--merge-output-format', 'mp4',
      '-o', '-',
      url
    ];
  }

  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', contentType);

  const ytdlp = spawn(YTDLP, ytdlpArgs);
  ytdlp.stdout.pipe(res);
  ytdlp.stderr.on('data', (data) => console.error('yt-dlp:', data.toString()));
  ytdlp.on('error', (err) => { console.error('spawn error:', err); res.status(500).end(); });
  req.on('close', () => ytdlp.kill());
});

setupYtDlp(() => {
  app.listen(3000, () => console.log('✅ Clipai running at http://localhost:3000'));
});
