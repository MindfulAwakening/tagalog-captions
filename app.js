// ============================================================
// Tagalog → English live captions — Anthropic-only version
//
// Records 5-second audio chunks via MediaRecorder (works on iOS),
// converts each chunk to base64, and sends it directly to Claude
// which both transcribes the Tagalog AND returns the English
// translation in a single API call. No OpenAI needed.
// ============================================================

const els = {
  dot:            document.getElementById('dot'),
  statusText:     document.getElementById('status-text'),
  stage:          document.getElementById('stage'),
  placeholder:    document.getElementById('placeholder'),
  listenBtn:      document.getElementById('listen-btn'),
  settingsBtn:    document.getElementById('settings-btn'),
  setup:          document.getElementById('setup'),
  apiKeyInput:    document.getElementById('api-key'),
  saveKeyBtn:     document.getElementById('save-key'),
  closeSetupBtn:  document.getElementById('close-setup'),
  errorContainer: document.getElementById('error-container'),
};

const KEY_STORAGE = 'tagalog_captions_anthropic_key';
let anthropicKey = localStorage.getItem(KEY_STORAGE) || '';

let mediaStream    = null;
let mediaRecorder  = null;
let shouldBeListening = false;
let chunkTimer     = null;
let processingQueue = [];
let isProcessing   = false;

const CHUNK_DURATION_MS  = 5000; // 5-second rolling windows
const MAX_BLOCKS_VISIBLE = 4;

// ---------- Setup screen ----------

function openSetup() {
  els.apiKeyInput.value = anthropicKey;
  els.setup.style.display = 'flex';
}

function closeSetup() {
  els.setup.style.display = 'none';
}

els.settingsBtn.addEventListener('click', openSetup);
els.closeSetupBtn.addEventListener('click', closeSetup);

els.saveKeyBtn.addEventListener('click', () => {
  const key = els.apiKeyInput.value.trim();
  if (!key || !key.startsWith('sk-ant-')) {
    showError('Enter a valid Anthropic API key (starts with sk-ant-).');
    return;
  }
  anthropicKey = key;
  localStorage.setItem(KEY_STORAGE, anthropicKey);
  closeSetup();
});

if (!anthropicKey) openSetup();

// ---------- Utilities ----------

let errorTimer = null;
function showError(msg) {
  els.errorContainer.innerHTML = `<div class="error-banner">${msg}</div>`;
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => { els.errorContainer.innerHTML = ''; }, 7000);
}

function setStatus(dotClass, text) {
  els.dot.className = 'dot' + (dotClass ? ' ' + dotClass : '');
  els.statusText.textContent = text;
}

function stopUI() {
  els.listenBtn.textContent = 'Start listening';
  els.listenBtn.classList.remove('listening');
  setStatus('', 'Ready');
}

// ---------- Audio format helpers ----------

function pickMimeType() {
  // Prefer mp4/aac on iOS, webm on Android/Chrome
  const candidates = ['audio/mp4', 'audio/aac', 'audio/webm;codecs=opus', 'audio/webm'];
  for (const t of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) {
      return t;
    }
  }
  return '';
}

function mediaTypeForMime(mimeType) {
  if (mimeType.includes('mp4'))  return 'audio/mp4';
  if (mimeType.includes('aac'))  return 'audio/mp4'; // aac sent as mp4 container
  if (mimeType.includes('webm')) return 'audio/webm';
  return 'audio/mp4'; // safe default for Claude
}

// ---------- Listen button ----------

els.listenBtn.addEventListener('click', async () => {
  if (!anthropicKey) { openSetup(); return; }
  if (!shouldBeListening) {
    await startListening();
  } else {
    stopListening();
  }
});

async function startListening() {
  if (!navigator.mediaDevices?.getUserMedia) {
    showError('Microphone not supported in this browser.');
    return;
  }
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    showError('Microphone access denied. Go to Settings → Safari → Microphone and allow access.');
    return;
  }
  shouldBeListening = true;
  els.listenBtn.textContent = 'Stop listening';
  els.listenBtn.classList.add('listening');
  setStatus('live', 'Listening');
  recordNextChunk();
}

function stopListening() {
  shouldBeListening = false;
  clearTimeout(chunkTimer);
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
  stopUI();
}

// ---------- Rolling chunk recorder ----------

function recordNextChunk() {
  if (!shouldBeListening || !mediaStream) return;

  const mimeType = pickMimeType();
  try {
    mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);
  } catch {
    showError('Could not start audio recorder on this device.');
    stopListening();
    return;
  }

  const localChunks = [];
  mediaRecorder.ondataavailable = e => { if (e.data?.size > 0) localChunks.push(e.data); };

  mediaRecorder.onstop = () => {
    if (localChunks.length > 0) {
      const blob = new Blob(localChunks, { type: mediaRecorder.mimeType || 'audio/mp4' });
      if (blob.size > 2000) enqueueChunk(blob); // skip near-silent chunks
    }
    if (shouldBeListening) recordNextChunk();
  };

  mediaRecorder.start();
  chunkTimer = setTimeout(() => {
    if (mediaRecorder?.state === 'recording') mediaRecorder.stop();
  }, CHUNK_DURATION_MS);
}

// ---------- Queue ----------

function enqueueChunk(blob) {
  processingQueue.push(blob);
  if (processingQueue.length > 3) processingQueue.shift(); // drop oldest if lagging
  processQueue();
}

async function processQueue() {
  if (isProcessing || processingQueue.length === 0) return;
  isProcessing = true;
  setStatus('live', 'Translating');

  const blob = processingQueue.shift();

  try {
    const result = await transcribeAndTranslate(blob);
    if (result) addCaptionBlock(result.tagalog, result.english);
  } catch (err) {
    console.error(err);
    showError(err.message || 'Translation failed — check your API key.');
  } finally {
    isProcessing = false;
    if (shouldBeListening) setStatus('live', 'Listening');
    processQueue();
  }
}

// ---------- Single Claude call: audio in → English out ----------

async function transcribeAndTranslate(blob) {
  // Convert blob to base64
  const base64 = await blobToBase64(blob);
  const mediaType = mediaTypeForMime(blob.type);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      system: `You are a Tagalog-to-English live caption assistant.
Listen to the audio. If it contains Tagalog or Taglish speech, respond with JSON only, like this:
{"tagalog":"<what was said>","english":"<natural English translation>"}
If the audio is silent, noise only, or has no meaningful speech, respond with exactly: SKIP
No other output. No markdown. No explanation.`,
      messages: [{
        role: 'user',
        content: [{
          type: 'document',
          source: {
            type: 'base64',
            media_type: mediaType,
            data: base64,
          },
        }, {
          type: 'text',
          text: 'Transcribe and translate the Tagalog speech in this audio clip.',
        }],
      }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    if (response.status === 401) throw new Error('Invalid Anthropic API key — tap ⚙ to update it.');
    if (response.status === 429) throw new Error('Rate limit hit — slow down or check your Anthropic plan.');
    throw new Error('API error ' + response.status + ': ' + body.slice(0, 120));
  }

  const data = await response.json();
  const textBlock = data.content.find(b => b.type === 'text');
  if (!textBlock) return null;

  const raw = textBlock.text.trim();
  if (raw === 'SKIP' || raw === '') return null;

  try {
    // Strip any accidental markdown fences before parsing
    const clean = raw.replace(/^```json|```$/gm, '').trim();
    const parsed = JSON.parse(clean);
    if (!parsed.english || isLowContent(parsed.english)) return null;
    return parsed;
  } catch {
    // If Claude returned plain English without JSON, show it anyway
    if (raw.length > 3 && !isLowContent(raw)) {
      return { tagalog: '', english: raw };
    }
    return null;
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      // result is "data:audio/mp4;base64,XXXX" — strip the prefix
      const base64 = reader.result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ---------- Filler filter ----------

const FILLER_PATTERNS = [
  /^[.\s…,!?]*$/,
  /^(uh+|um+|hm+|ah+|oh+)[.\s!?]*$/i,
  /^(thank you\.?|thanks\.?|you\.?)$/i,
];

function isLowContent(text) {
  const t = text.trim();
  if (t.length < 3) return true;
  if (t.split(/\s+/).filter(Boolean).length === 1 && t.length < 6) return true;
  return FILLER_PATTERNS.some(p => p.test(t));
}

// ---------- Caption rendering ----------

function addCaptionBlock(tagalogText, englishText) {
  if (!englishText) return;

  if (els.placeholder) { els.placeholder.remove(); els.placeholder = null; }

  const prev = els.stage.querySelector('.caption-block.current');
  if (prev) { prev.classList.remove('current'); prev.classList.add('fading'); }

  const block = document.createElement('div');
  block.className = 'caption-block current';
  block.innerHTML = `
    ${tagalogText ? `<div class="source-line">${escapeHtml(tagalogText)}</div>` : ''}
    <div class="english-line">${escapeHtml(englishText)}</div>
  `;
  els.stage.appendChild(block);
  block.scrollIntoView({ block: 'end' });

  const blocks = els.stage.querySelectorAll('.caption-block');
  if (blocks.length > MAX_BLOCKS_VISIBLE) blocks[0].remove();
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ---------- PWA service worker ----------

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
