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
  }).on('error', (err) => { console.error('❌ Failed to download yt-dlp:', err); callback(); });
}

app.post('/api/convert', (req, res) => {
  const { url, format, quality } = req.body;
  if (!url) return res.status(400).json({ message: 'No URL provided' });

  const outputDir = path.join(__dirname, 'downloads');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

  const filename = `download_${Date.now()}`;
  let outputPath, cmd;

  if (format === 'mp3') {
    const bitrate = quality ? quality.replace(' kbps', '') : '192';
    outputPath = path.join(outputDir, filename + '.mp3');
    cmd = `"${YTDLP}" -x --audio-format mp3 --audio-quality ${bitrate}K -o "${outputPath}" "${url}"`;
  } else {
    const heights = { '480p': 480, '720p': 720, '1080p': 1080, '4K': 2160 };
    const h = heights[quality] || 720;
    outputPath = path.join(outputDir, filename + '.mp4');
    cmd = `"${YTDLP}" -f "bestvideo[height<=${h}]+bestaudio/best[height<=${h}]" --merge-output-format mp4 -o "${outputPath}" "${url}"`;
  }

  // Get video info first
  exec(`"${YTDLP}" --print "%(title)s|||%(duration_string)s|||%(id)s" "${url}"`, (err, stdout) => {
    const parts = (stdout || '').trim().split('|||');
    const title = parts[0] || 'Video';
    const duration = parts[1] || '';
    const videoId = parts[2] || '';
    // Use YouTube's direct thumbnail URL instead of yt-dlp's
    const thumbnail = videoId ? `https://img.youtube.com/vi/${videoId}/mqdefault.jpg` : null;

    exec(cmd, (err2, stdout2, stderr2) => {
      if (err2) {
        console.error('Conversion error:', stderr2);
        return res.status(500).json({ message: 'Conversion failed: ' + stderr2 });
      }

      // Use full Railway URL for download link
      const host = req.headers.host;
      const protocol = req.headers['x-forwarded-proto'] || 'https';
      const downloadUrl = `${protocol}://${host}/downloads/${path.basename(outputPath)}`;

      res.json({ title, thumbnail, duration, downloadUrl });
      setTimeout(() => { try { fs.unlinkSync(outputPath); } catch(e){} }, 30 * 60 * 1000);
    });
  });
});

app.use('/downloads', express.static(path.join(__dirname, 'downloads')));

setupYtDlp(() => {
  app.listen(3000, () => console.log('✅ Clipai running at http://localhost:3000'));
});
