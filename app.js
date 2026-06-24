// ============================================================
// Tagalog → English live captions (iOS-compatible version)
//
// iOS Safari's built-in speech recognition is unreliable for
// continuous listening, so instead this app records short audio
// chunks (MediaRecorder, well supported on iOS) and sends each
// chunk to OpenAI Whisper for Tagalog transcription, then to
// Claude for English translation.
//
// Audio chunks are sent directly to OpenAI for transcription only
// and are not stored anywhere. Transcribed text is sent to
// Anthropic for translation only.
// ============================================================

const els = {
  dot: document.getElementById('dot'),
  statusText: document.getElementById('status-text'),
  stage: document.getElementById('stage'),
  placeholder: document.getElementById('placeholder'),
  listenBtn: document.getElementById('listen-btn'),
  settingsBtn: document.getElementById('settings-btn'),
  setup: document.getElementById('setup'),
  apiKeyInput: document.getElementById('api-key'),
  openaiKeyInput: document.getElementById('openai-key'),
  saveKeyBtn: document.getElementById('save-key'),
  closeSetupBtn: document.getElementById('close-setup'),
  errorContainer: document.getElementById('error-container'),
};

const ANTHROPIC_KEY_STORAGE = 'tagalog_captions_anthropic_key';
const OPENAI_KEY_STORAGE = 'tagalog_captions_openai_key';

let anthropicKey = localStorage.getItem(ANTHROPIC_KEY_STORAGE) || '';
let openaiKey = localStorage.getItem(OPENAI_KEY_STORAGE) || '';

let mediaStream = null;
let mediaRecorder = null;
let shouldBeListening = false;
let chunkTimer = null;
let processingQueue = [];
let isProcessing = false;

const CHUNK_DURATION_MS = 4000; // record in ~4 second rolling windows
const MAX_BLOCKS_VISIBLE = 4;

// ---------- Setup screen ----------

function openSetup() {
  els.apiKeyInput.value = anthropicKey;
  els.openaiKeyInput.value = openaiKey;
  els.setup.style.display = 'flex';
}

function closeSetup() {
  els.setup.style.display = 'none';
}

els.settingsBtn.addEventListener('click', openSetup);
els.closeSetupBtn.addEventListener('click', closeSetup);

els.saveKeyBtn.addEventListener('click', () => {
  const aKey = els.apiKeyInput.value.trim();
  const oKey = els.openaiKeyInput.value.trim();
  if (!aKey || !oKey) {
    showError('Both API keys are required to continue.');
    return;
  }
  anthropicKey = aKey;
  openaiKey = oKey;
  localStorage.setItem(ANTHROPIC_KEY_STORAGE, anthropicKey);
  localStorage.setItem(OPENAI_KEY_STORAGE, openaiKey);
  closeSetup();
});

if (!anthropicKey || !openaiKey) {
  openSetup();
}

// ---------- Error banner ----------

let errorTimer = null;
function showError(msg) {
  els.errorContainer.innerHTML = `<div class="error-banner">${msg}</div>`;
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => { els.errorContainer.innerHTML = ''; }, 6000);
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

// ---------- Pick a supported audio mime type ----------

function pickMimeType() {
  const candidates = [
    'audio/mp4',
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/aac',
  ];
  for (const type of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  return ''; // let the browser pick a default
}

// ---------- Start / stop listening ----------

els.listenBtn.addEventListener('click', async () => {
  if (!anthropicKey || !openaiKey) {
    openSetup();
    return;
  }

  if (!shouldBeListening) {
    await startListening();
  } else {
    stopListening();
  }
});

async function startListening() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showError('This browser does not support microphone access.');
    return;
  }

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    showError('Microphone access was denied. Enable it in Settings → Safari → Microphone.');
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

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }

  stopUI();
}

function recordNextChunk() {
  if (!shouldBeListening || !mediaStream) return;

  const mimeType = pickMimeType();
  const options = mimeType ? { mimeType } : undefined;

  try {
    mediaRecorder = new MediaRecorder(mediaStream, options);
  } catch (err) {
    showError('Could not start the audio recorder on this device.');
    stopListening();
    return;
  }

  const localChunks = [];

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) localChunks.push(e.data);
  };

  mediaRecorder.onstop = () => {
    if (localChunks.length > 0) {
      const blob = new Blob(localChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      // only queue chunks with meaningful size — skip near-silent empty chunks
      if (blob.size > 2000) {
        enqueueChunk(blob);
      }
    }
    // immediately start the next chunk if still listening
    if (shouldBeListening) {
      recordNextChunk();
    }
  };

  mediaRecorder.start();

  // stop this chunk after CHUNK_DURATION_MS, which triggers onstop → next chunk starts
  chunkTimer = setTimeout(() => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
    }
  }, CHUNK_DURATION_MS);
}

// ---------- Processing queue: transcribe then translate ----------

function enqueueChunk(blob) {
  processingQueue.push(blob);
  // avoid unbounded backlog if network is slow — keep only the most recent few
  if (processingQueue.length > 3) {
    processingQueue.shift();
  }
  processQueue();
}

async function processQueue() {
  if (isProcessing || processingQueue.length === 0) return;
  isProcessing = true;
  setStatus('live', 'Transcribing');

  const blob = processingQueue.shift();

  try {
    const tagalogText = await transcribe(blob);
    if (tagalogText && tagalogText.trim() && !isLowContent(tagalogText)) {
      setStatus('live', 'Translating');
      const englishText = await translate(tagalogText.trim());
      addCaptionBlock(tagalogText.trim(), englishText);
    }
  } catch (err) {
    console.error(err);
    showError(err.message || 'Something went wrong processing audio.');
  } finally {
    isProcessing = false;
    if (shouldBeListening) setStatus('live', 'Listening');
    processQueue();
  }
}

function extensionForMime(mimeType) {
  if (mimeType.includes('mp4')) return 'mp4';
  if (mimeType.includes('webm')) return 'webm';
  if (mimeType.includes('aac')) return 'aac';
  return 'webm';
}

// Filters out near-empty or noise transcriptions so they never reach
// the translation API. Whisper often returns short filler artifacts
// for silence, background noise, or breathing — none of that is worth
// a translation call.
const FILLER_PATTERNS = [
  /^[.\s…]*$/i,                 // just punctuation/whitespace
  /^(uh+|um+|hm+|ah+|oh+)[.\s!?]*$/i, // single filler sound
  /^(thank you\.?|thanks\.?)$/i,      // common Whisper hallucination on silence
  /^you\.?$/i,                        // another common silence hallucination
];

function isLowContent(text) {
  const trimmed = text.trim();
  if (trimmed.length < 3) return true;
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  if (wordCount === 1 && trimmed.length < 6) return true;
  return FILLER_PATTERNS.some((pattern) => pattern.test(trimmed));
}

async function transcribe(blob) {
  const ext = extensionForMime(blob.type);
  const formData = new FormData();
  formData.append('file', blob, `chunk.${ext}`);
  formData.append('model', 'whisper-1');
  formData.append('language', 'tl'); // ISO code for Tagalog
  formData.append('response_format', 'text');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openaiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errBody = await response.text();
    if (response.status === 401) throw new Error('OpenAI API key is invalid.');
    throw new Error('Transcription error ' + response.status + ': ' + errBody.slice(0, 120));
  }

  return await response.text();
}

async function translate(tagalogText) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: "Translate Tagalog/Taglish to casual English. Output only the translation, nothing else.",
      messages: [
        { role: 'user', content: tagalogText }
      ],
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    if (response.status === 401) throw new Error('Anthropic API key is invalid.');
    throw new Error('Translation error ' + response.status + ': ' + errBody.slice(0, 120));
  }

  const data = await response.json();
  const textBlock = data.content.find((b) => b.type === 'text');
  return textBlock ? textBlock.text.trim() : '';
}

// ---------- Caption rendering ----------

function addCaptionBlock(sourceText, englishText) {
  if (!englishText) return;

  if (els.placeholder) {
    els.placeholder.remove();
    els.placeholder = null;
  }

  const prevCurrent = els.stage.querySelector('.caption-block.current');
  if (prevCurrent) {
    prevCurrent.classList.remove('current');
    prevCurrent.classList.add('fading');
  }

  const block = document.createElement('div');
  block.className = 'caption-block current';
  block.innerHTML = `
    <div class="source-line">${escapeHtml(sourceText)}</div>
    <div class="english-line">${escapeHtml(englishText)}</div>
  `;
  els.stage.appendChild(block);
  block.scrollIntoView({ block: 'end' });

  const blocks = els.stage.querySelectorAll('.caption-block');
  if (blocks.length > MAX_BLOCKS_VISIBLE) {
    blocks[0].remove();
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------- Register service worker (PWA installability) ----------

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
