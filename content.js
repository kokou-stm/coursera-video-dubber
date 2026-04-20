'use strict';

// ─── État global ──────────────────────────────────────────────────────────────
let state = {
  active: false,
  lang: 'fr',
  segments: [],
  audioCache: {},     // index → HTMLAudioElement prêt à jouer
  synthQueue: new Set(),
  synthErrors: 0,
  video: null,
  currentIdx: -1,
  handlers: {},
  audioCtx: null,     // AudioContext débloqué par le clic utilisateur
};

// ─── Écoute les messages du popup ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'activate') {
    // Débloquer l'AudioContext ICI — on est dans un événement utilisateur (clic popup)
    if (!state.audioCtx) {
      state.audioCtx = new AudioContext();
    }
    startDubbing(request.lang, request.voice);
    sendResponse({ ok: true });
  } else if (request.action === 'deactivate') {
    stopDubbing();
    sendResponse({ ok: true });
  }
});

// ─── Démarrage ────────────────────────────────────────────────────────────────
async function startDubbing(lang, voice) {
  if (state.active) stopDubbing();
  state.lang  = lang;
  state.voice = voice || null;
  state.active = true;
  state.synthErrors = 0;

  showOverlay('Recherche de la vidéo...');

  // YouTube : prendre la vidéo principale (pas les pubs)
  state.video = getSite() === 'youtube'
    ? document.querySelector('video.video-stream, #movie_player video')
    : document.querySelector('video');

  if (!state.video) {
    showOverlay('Erreur : aucune vidéo trouvée sur la page.', 'error');
    return;
  }

  showOverlay('Lecture de la transcription...');
  state.segments = parseTranscript();

  if (state.segments.length === 0) {
    showOverlay('Transcription introuvable. Ouvre le panneau "Transcription" et réessaie.', 'error');
    return;
  }

  console.log('[Dubber] Segments trouvés :', state.segments.length);

  // Couper le son original et attacher les événements immédiatement
  state.video.muted = true;

  state.handlers.timeupdate = () => onTimeUpdate();
  state.handlers.pause      = () => pauseCurrentAudio();
  state.handlers.play       = () => resumeCurrentAudio();
  state.handlers.seeked     = () => onSeeked();

  state.video.addEventListener('timeupdate', state.handlers.timeupdate);
  state.video.addEventListener('pause',      state.handlers.pause);
  state.video.addEventListener('play',       state.handlers.play);
  state.video.addEventListener('seeked',     state.handlers.seeked);

  // Traduire le premier petit lot pour démarrer vite, puis le reste en arrière-plan
  showOverlay('Traduction en cours...');
  const startIdx = Math.max(0, getCurrentSegmentIndex());
  try {
    await translateSegmentRange(startIdx, Math.min(startIdx + 5, state.segments.length), lang);
  } catch (e) {
    showOverlay('Erreur de traduction : ' + e.message, 'error');
    return;
  }
  if (!state.active) return;

  // Lancer la synthèse des premiers segments dès maintenant
  prefetchAround(startIdx);
  showOverlay('Doublage actif ✓ — chargement en cours...', 'ok');
  setTimeout(() => hideOverlay(), 2500);

  // Traduire le reste en arrière-plan sans bloquer
  translateRemainingInBackground(startIdx + 5, lang);
}

// Traduit un lot de segments et stocke les traductions
async function translateSegmentRange(from, to, lang) {
  if (from >= state.segments.length) return;
  to = Math.min(to, state.segments.length);
  const texts = state.segments.slice(from, to).map(s => s.text);
  const translated = await requestTranslation(texts, 'en', lang);
  if (!state.active) return;
  translated.forEach((t, i) => {
    if (state.segments[from + i]) state.segments[from + i].translatedText = t;
  });
  // Synthétiser les segments qui sont proches de la position actuelle
  const curIdx = Math.max(0, state.currentIdx);
  if (from <= curIdx + 8) prefetchAround(curIdx);
}

// Traduit le reste des segments en arrière-plan par lots de 20
async function translateRemainingInBackground(startFrom, lang) {
  const BATCH = 20;
  for (let i = startFrom; i < state.segments.length; i += BATCH) {
    if (!state.active) return;
    try {
      await translateSegmentRange(i, i + BATCH, lang);
    } catch (e) {
      console.warn('[Dubber] Erreur traduction arrière-plan lot', i, ':', e.message);
    }
    // Petite pause pour ne pas saturer l'API
    await new Promise(r => setTimeout(r, 200));
  }
  console.log('[Dubber] Toute la traduction est terminée.');
}

function stopDubbing() {
  if (!state.active) return;
  state.active = false;

  if (state.video) {
    state.video.muted = false;
    Object.entries(state.handlers).forEach(([event, handler]) => {
      state.video.removeEventListener(event, handler);
    });
    state.video = null;
  }

  Object.values(state.audioCache).forEach(audio => {
    audio.pause();
    if (audio.src) URL.revokeObjectURL(audio.src);
  });

  state.segments   = [];
  state.audioCache = {};
  state.synthQueue = new Set();
  state.currentIdx = -1;
  state.handlers   = {};

  removeOverlay();
}

// ─── Détection du site ────────────────────────────────────────────────────────
function getSite() {
  if (location.hostname.includes('youtube.com')) return 'youtube';
  if (location.hostname.includes('coursera.org')) return 'coursera';
  return 'unknown';
}

// ─── Fusionne les segments trop courts pour éviter les micro-coupures ─────────
function mergeShortSegments(segs, minDuration = 3) {
  const result = [];
  let current = null;

  for (const seg of segs) {
    if (!current) {
      current = { ...seg };
      continue;
    }
    const duration = seg.startTime - current.startTime;
    if (duration < minDuration) {
      // Fusionner avec le segment courant
      current.text    += ' ' + seg.text;
      current.endTime  = seg.endTime;
    } else {
      result.push(current);
      current = { ...seg };
    }
  }
  if (current) result.push(current);
  return result;
}

// ─── Parsing du transcript (dispatch selon le site) ──────────────────────────
function parseTranscript() {
  if (getSite() === 'youtube') return parseYouTubeTranscript();
  return parseCourseraTranscript();
}

// ─── Parser YouTube ───────────────────────────────────────────────────────────
function parseYouTubeTranscript() {
  // YouTube : segments dans ytd-transcript-segment-renderer
  const segmentEls = document.querySelectorAll('ytd-transcript-segment-renderer');

  if (segmentEls.length === 0) {
    // Transcript pas ouvert — proposer de l'ouvrir automatiquement
    openYouTubeTranscript();
    return [];
  }

  const segs = [...segmentEls].map(el => {
    const timeEl = el.querySelector('.segment-timestamp, [class*="timestamp"]');
    const textEl = el.querySelector('.segment-text,    [class*="segment-text"]');
    if (!timeEl || !textEl) return null;

    // Convertir "1:23" ou "1:23:45" en secondes
    const parts = timeEl.textContent.trim().split(':').map(Number);
    let startTime = 0;
    if (parts.length === 2) startTime = parts[0] * 60 + parts[1];
    if (parts.length === 3) startTime = parts[0] * 3600 + parts[1] * 60 + parts[2];

    return { startTime, text: textEl.textContent.replace(/\s+/g, ' ').trim() };
  }).filter(s => s && s.text.length > 1 && !isNaN(s.startTime));

  if (segs.length === 0) return [];

  segs.forEach((s, i) => {
    s.endTime = i + 1 < segs.length ? segs[i + 1].startTime : s.startTime + 6;
    s.translatedText = null;
  });

  const merged = mergeShortSegments(segs);
  console.log('[Dubber] YouTube transcript :', segs.length, '→ fusionnés :', merged.length);
  return merged;
}

// Ouvre automatiquement le panneau transcript YouTube
function openYouTubeTranscript() {
  // Cherche le bouton "..." sous la vidéo puis "Afficher la transcription"
  const moreBtn = document.querySelector('ytd-video-description-transcript-section-renderer button, #primary-button button');
  if (moreBtn) {
    moreBtn.click();
    // Attendre que le panel s'ouvre
    setTimeout(() => {
      const transcriptBtn = [...document.querySelectorAll('tp-yt-paper-item, ytd-menu-service-item-renderer')]
        .find(el => /transcri/i.test(el.textContent));
      if (transcriptBtn) transcriptBtn.click();
    }, 500);
  } else {
    showOverlay('Ouvre le transcript YouTube manuellement : bouton "..." → "Afficher la transcription", puis réactive.', 'error');
  }
}

function parseCourseraTranscript() {
  // Méthode 1 : attribut data-start-time
  const byAttr = document.querySelectorAll('[data-start-time]');
  if (byAttr.length > 0) {
    const segs = [...byAttr]
      .map(el => ({
        startTime: parseFloat(el.getAttribute('data-start-time')),
        text: el.textContent.replace(/\s+/g, ' ').trim(),
      }))
      .filter(s => s.text.length > 0 && !isNaN(s.startTime));
    segs.forEach((s, i) => {
      s.endTime = i + 1 < segs.length ? segs[i + 1].startTime : s.startTime + 6;
      s.translatedText = null;
    });
    if (segs.length > 0) {
      const merged = mergeShortSegments(segs);
      console.log('[Dubber] data-start-time :', segs.length, '→ après fusion :', merged.length);
      return merged;
    }
  }

  // Méthode 2 : cherche des éléments enfants avec timestamp MM:SS dans le texte
  const containers = [
    '.rc-Transcript', '[class*="Transcript"]', '[class*="transcript"]', '[class*="phrases"]',
  ];
  for (const sel of containers) {
    const container = document.querySelector(sel);
    if (!container) continue;

    // Cherche tous les éléments enfants directs (phrases)
    const children = [...container.querySelectorAll('div, p, span')]
      .filter(el => el.children.length <= 2 && el.textContent.trim().length > 2);

    // Essaie de détecter un pattern MM:SS ou M:SS dans chaque élément
    const timeRegex = /^(\d{1,2}):(\d{2})/;
    const phrasesWithTime = children
      .map(el => {
        const txt = el.textContent.trim();
        const m = txt.match(timeRegex);
        if (m) {
          return {
            startTime: parseInt(m[1]) * 60 + parseInt(m[2]),
            text: txt.replace(timeRegex, '').trim(),
          };
        }
        // Cherche un élément frère ou enfant qui est un timestamp
        const timeEl = el.querySelector('span, div');
        if (timeEl) {
          const m2 = timeEl.textContent.trim().match(timeRegex);
          if (m2) {
            const rest = txt.replace(timeEl.textContent.trim(), '').trim();
            return { startTime: parseInt(m2[1]) * 60 + parseInt(m2[2]), text: rest };
          }
        }
        return null;
      })
      .filter(s => s && s.text.length > 3 && !isNaN(s.startTime));

    if (phrasesWithTime.length > 2) {
      phrasesWithTime.forEach((s, i) => {
        s.endTime = i + 1 < phrasesWithTime.length ? phrasesWithTime[i + 1].startTime : s.startTime + 6;
        s.translatedText = null;
      });
      console.log('[Dubber] Timestamps MM:SS trouvés :', phrasesWithTime.length);
      return phrasesWithTime;
    }

    // Méthode 3 : pas de timestamps — découpe le texte en segments de ~150 chars
    // et estime les timestamps selon ~2.5 mots/sec (vitesse de parole moyenne)
    const fullText = container.textContent.replace(/\s+/g, ' ').trim();
    if (fullText.length < 20) continue;

    const words = fullText.split(' ').filter(w => w.length > 0);
    const WORDS_PER_SEGMENT = 20; // ~8 secondes par segment
    const WORDS_PER_SEC = 2.5;
    const segs = [];
    for (let i = 0; i < words.length; i += WORDS_PER_SEGMENT) {
      const chunk = words.slice(i, i + WORDS_PER_SEGMENT).join(' ');
      segs.push({
        startTime: (i / WORDS_PER_SEC),
        endTime: ((i + WORDS_PER_SEGMENT) / WORDS_PER_SEC),
        text: chunk,
        translatedText: null,
      });
    }
    console.log('[Dubber] Fallback découpage en', segs.length, 'segments estimés (sans timestamps)');
    return segs;
  }

  return [];
}

// ─── Synchronisation vidéo ────────────────────────────────────────────────────
function onTimeUpdate() {
  const idx = getCurrentSegmentIndex();

  // Un audio est déjà en train de jouer → ne pas interrompre
  // Le handler `ended` se chargera d'avancer au segment suivant
  const playing = state.audioCache[state.currentIdx];
  if (playing && !playing.paused) {
    prefetchAround(idx); // prefetch en silencieux
    return;
  }

  // Rien ne joue et on a changé de segment → démarrer
  if (idx !== state.currentIdx) {
    state.currentIdx = idx;
    if (idx >= 0) {
      prefetchAround(idx);
      playSegment(idx);
    }
  }
}

function onSeeked() {
  // Seek manuel → couper immédiatement et resynchroniser depuis la nouvelle position
  stopCurrentAudio();
  state.currentIdx = -1;
  const idx = getCurrentSegmentIndex();
  state.currentIdx = idx;
  if (idx >= 0) {
    prefetchAround(idx);
    playSegment(idx);
  }
}

function stopCurrentAudio() {
  const audio = state.audioCache[state.currentIdx];
  if (audio) {
    audio.pause();
    audio.currentTime = 0;
  }
}

function pauseCurrentAudio() {
  const audio = state.audioCache[state.currentIdx];
  if (audio && !audio.paused) audio.pause();
}

function resumeCurrentAudio() {
  const audio = state.audioCache[state.currentIdx];
  if (audio && audio.paused && audio.src) {
    audio.play().catch(() => {});
  }
}

function getCurrentSegmentIndex() {
  if (!state.video || state.segments.length === 0) return -1;
  const t = state.video.currentTime;
  for (let i = state.segments.length - 1; i >= 0; i--) {
    if (state.segments[i].startTime <= t) return i;
  }
  return 0;
}

// ─── Synthèse vocale progressive ──────────────────────────────────────────────
function prefetchAround(centerIdx) {
  const LOOKAHEAD = 4;
  const start = Math.max(0, centerIdx);
  const end   = Math.min(state.segments.length - 1, centerIdx + LOOKAHEAD);
  for (let i = start; i <= end; i++) {
    if (!state.audioCache[i] && !state.synthQueue.has(i)) {
      synthesizeSegment(i);
    }
  }
}

async function synthesizeSegment(idx) {
  if (state.synthQueue.has(idx) || state.audioCache[idx]) return;
  state.synthQueue.add(idx);

  const seg = state.segments[idx];
  if (!seg || !seg.translatedText) {
    state.synthQueue.delete(idx);
    return;
  }

  try {
    const audioData = await requestSynthesis(seg.translatedText, state.lang);
    // audio/mpeg est le MIME type correct pour le MP3 retourné par Azure TTS
    const blob  = new Blob([audioData], { type: 'audio/mpeg' });
    const url   = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.preload = 'auto';

    // Charger l'audio en mémoire avant de le stocker
    await new Promise((resolve, reject) => {
      audio.addEventListener('canplaythrough', resolve, { once: true });
      audio.addEventListener('error', (e) => reject(new Error('Audio invalide : ' + (e.message || 'format non supporté'))), { once: true });
      audio.load();
    });

    // Quand cet audio se termine, jouer le suivant s'il est le segment courant
    audio.addEventListener('ended', () => {
      if (state.active && idx === state.currentIdx) {
        const next = idx + 1;
        if (next < state.segments.length) {
          state.currentIdx = next;
          prefetchAround(next);
          playSegment(next);
        }
      }
    });

    state.audioCache[idx] = audio;
    console.log(`[Dubber] Segment ${idx} prêt (${seg.translatedText.substring(0, 30)}...)`);

    // Auto-play uniquement si c'est le segment courant, que rien d'autre ne joue,
    // et que la vidéo tourne
    const currentlyPlaying = state.audioCache[state.currentIdx];
    const somethingPlaying = currentlyPlaying && !currentlyPlaying.paused;
    if (idx === state.currentIdx && !somethingPlaying && state.video && !state.video.paused) {
      audio.play().catch(e => console.warn('[Dubber] play() échoué :', e));
    }

    // Mettre à jour l'overlay après le premier segment prêt
    if (idx === 0 || (idx <= 2 && Object.keys(state.audioCache).length === 1)) {
      showOverlay('Doublage actif ✓', 'ok');
      setTimeout(() => hideOverlay(), 2500);
    }
  } catch (e) {
    state.synthErrors++;
    console.error(`[Dubber] Synthèse échouée segment ${idx}:`, e);
    if (state.synthErrors <= 2) {
      showOverlay('Erreur TTS : ' + e.message, 'error');
    }
  } finally {
    state.synthQueue.delete(idx);
  }
}

function playSegment(idx) {
  if (!state.active || !state.video || state.video.paused) return;
  const audio = state.audioCache[idx];
  if (audio) {
    audio.currentTime = 0;
    const playPromise = audio.play();
    if (playPromise) {
      playPromise.catch(e => console.warn(`[Dubber] play() segment ${idx} échoué:`, e.message));
    }
  }
}

// ─── Appels API via le background (avec retry si service worker endormi) ──────
async function sendMessageWithRetry(message, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(message, response => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(response);
          }
        });
      });
      return response;
    } catch (e) {
      const isRetryable = e.message.includes('context invalidated') ||
                          e.message.includes('Could not establish connection') ||
                          e.message.includes('receiving end does not exist');

      if (isRetryable && attempt < maxRetries - 1) {
        console.warn(`[Dubber] Service worker endormi, retry ${attempt + 1}/${maxRetries}...`);
        await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
        continue;
      }

      // Erreur définitive : contexte vraiment invalidé (extension rechargée)
      if (e.message.includes('context invalidated')) {
        showOverlay('Extension rechargée — recharge la page pour continuer.', 'error');
      }
      throw e;
    }
  }
}

async function requestTranslation(texts, from, to) {
  const response = await sendMessageWithRetry({ action: 'translate', texts, from, to });
  if (response.error) throw new Error(response.error);
  return response.translated;
}

async function requestSynthesis(text, lang) {
  const response = await sendMessageWithRetry({ action: 'synthesize', text, lang, voice: state.voice });
  if (response.error) throw new Error(response.error);
  // Reconvertir le base64 en ArrayBuffer
  const binary = atob(response.audioBase64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// ─── UI overlay ───────────────────────────────────────────────────────────────
function showOverlay(message, type = 'info') {
  let el = document.getElementById('dubber-overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'dubber-overlay';
    el.style.cssText = `
      position: fixed; top: 16px; right: 16px; z-index: 999999;
      padding: 10px 16px; border-radius: 8px; font-size: 13px;
      font-family: sans-serif; font-weight: 500; max-width: 320px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3); color: #fff;
      transition: opacity 0.4s;
    `;
    document.body.appendChild(el);
  }
  const bg = { info: '#1a73e8', error: '#d93025', ok: '#188038' };
  el.style.background = bg[type] || bg.info;
  el.style.opacity = '1';
  el.textContent = message;
}

function hideOverlay() {
  const el = document.getElementById('dubber-overlay');
  if (el) el.style.opacity = '0';
}

function removeOverlay() {
  const el = document.getElementById('dubber-overlay');
  if (el) el.remove();
}
