importScripts('config.js');

const AOAI_ENDPOINT       = CONFIG.AOAI_ENDPOINT;
const AOAI_KEY            = CONFIG.AOAI_KEY;
const TRANSLATOR_KEY      = CONFIG.TRANSLATOR_KEY;
const TRANSLATOR_REGION   = CONFIG.TRANSLATOR_REGION;
const TRANSLATOR_ENDPOINT = CONFIG.TRANSLATOR_ENDPOINT;
const SPEECH_KEY          = CONFIG.SPEECH_KEY;
const SPEECH_REGION       = CONFIG.SPEECH_REGION;

const VOICES = {
  fr: 'fr-FR-DeniseNeural',
  es: 'es-ES-ElviraNeural',
  de: 'de-DE-KatjaNeural',
  en: 'en-US-JennyNeural',
  pt: 'pt-BR-FranciscaNeural',
  it: 'it-IT-ElsaNeural',
  zh: 'zh-CN-XiaoxiaoNeural',
  ja: 'ja-JP-NanamiNeural',
  ar: 'ar-SA-ZariyahNeural',
};

let tokenCache = { token: null, expiresAt: 0 };

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'translate') {
    translateBatch(request.texts, request.from, request.to)
      .then(translated => sendResponse({ translated }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (request.action === 'synthesize') {
    synthesize(request.text, request.lang, request.voice)
      .then(audioData => {
        const bytes = new Uint8Array(audioData);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64 = btoa(binary);
        sendResponse({ audioBase64: base64 });
      })
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }
});

async function translateBatch(texts, from, to) {
  const LANG_NAMES = {
    fr: 'français', es: 'espagnol', de: 'allemand', pt: 'portugais',
    it: 'italien', zh: 'chinois', ja: 'japonais', ar: 'arabe', en: 'anglais',
  };
  const targetLang = LANG_NAMES[to] || to;

  const numbered = texts.map((t, i) => `[${i}] ${t}`).join('\n');

  const systemPrompt = `Tu es un interprète simultané professionnel spécialisé dans les cours universitaires de technologie et d'intelligence artificielle.
Ta mission : traduire en ${targetLang} des segments de transcript de cours vidéo, de façon naturelle et fluide, comme si tu parlais à voix haute.

Règles strictes :
- Traduis chaque segment numéroté [N] en gardant la même numérotation dans ta réponse
- Style oral naturel : pas de jargon inutile, pas de tournures trop formelles
- Garde les termes techniques en anglais quand ils sont plus courants (ex: "machine learning", "neural network", "dataset")
- Ignore et supprime les annotations comme [MUSIC], [APPLAUSE], (inaudible)
- Ne traduis pas les noms propres, acronymes
- Pour les langues européennes (français, espagnol, etc.) : utilise la virgule comme séparateur décimal (écris "0,5" pas "0.5")
- Supprime les annotations comme [MUSIC], [APPLAUSE], (inaudible) — ne les traduis pas
- Réponds UNIQUEMENT avec les segments traduits numérotés, rien d'autre`;

  const response = await fetch(AOAI_ENDPOINT, {
    method: 'POST',
    headers: {
      'api-key': AOAI_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: numbered },
      ],
      temperature: 0.3,
      max_tokens: Math.min(texts.length * 80, 4000),
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    console.warn('[Dubber] GPT-4o échoué, fallback Azure Translator :', err);
    return translateBatchFallback(texts, from, to);
  }

  const data   = await response.json();
  const output = data.choices[0].message.content;

  const result = new Array(texts.length).fill('');
  const lines  = output.split('\n').filter(l => l.trim());
  for (const line of lines) {
    const m = line.match(/^\[(\d+)\]\s*(.+)/);
    if (m) {
      const idx = parseInt(m[1]);
      if (idx < result.length) result[idx] = m[2].trim();
    }
  }

  const missing = result.map((t, i) => t ? null : i).filter(i => i !== null);
  if (missing.length > 0) {
    console.warn('[Dubber] Segments manquants dans la réponse GPT, fallback pour :', missing);
    const fallbackTexts = missing.map(i => texts[i]);
    const fallbackResult = await translateBatchFallback(fallbackTexts, from, to);
    missing.forEach((idx, j) => { result[idx] = fallbackResult[j]; });
  }

  return result;
}

async function translateBatchFallback(texts, from, to) {
  const response = await fetch(
    `${TRANSLATOR_ENDPOINT}translate?api-version=3.0&from=${from}&to=${to}`,
    {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': TRANSLATOR_KEY,
        'Ocp-Apim-Subscription-Region': TRANSLATOR_REGION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(texts.map(text => ({ text }))),
    }
  );
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Translator API ${response.status}: ${err}`);
  }
  const data = await response.json();
  return data.map(item => item.translations[0].text);
}

async function synthesize(text, lang, voiceOverride) {
  const token = await getAccessToken();
  const voice = voiceOverride || VOICES[lang] || VOICES['fr'];
  const locale = voice.split('-').slice(0, 2).join('-');

  const ssml = `<speak version='1.0' xml:lang='${locale}'>
    <voice xml:lang='${locale}' name='${voice}'>
      <prosody rate='0%'>
        ${escapeXml(cleanForTTS(text, lang))}
      </prosody>
    </voice>
  </speak>`;

  const response = await fetch(
    `https://${SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3',
        'User-Agent': 'CourseraDubber',
      },
      body: ssml,
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`TTS API ${response.status}: ${err}`);
  }

  return await response.arrayBuffer();
}

async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expiresAt) {
    return tokenCache.token;
  }

  const response = await fetch(
    `https://${SPEECH_REGION}.api.cognitive.microsoft.com/sts/v1.0/issuetoken`,
    {
      method: 'POST',
      headers: { 'Ocp-Apim-Subscription-Key': SPEECH_KEY },
    }
  );

  if (!response.ok) {
    throw new Error(`Échec de récupération du token Azure TTS: ${response.status}`);
  }

  const token = await response.text();
  tokenCache = { token, expiresAt: now + 9 * 60 * 1000 };
  return token;
}

function cleanForTTS(text, lang) {
  let t = text
    .replace(/\[.*?\]/g, '')
    .replace(/\(.*?\)/g, '')
    .replace(/\.{2,}/g, ' ')
    .replace(/([!?])/g, '$1 ')
    .replace(/\./g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const useCommaDecimal = ['fr', 'es', 'de', 'pt', 'it'].includes(lang);
  if (useCommaDecimal) {
    t = t.replace(/(\d),(\d)/g, '$1,$2');
  }

  return t;
}

function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
